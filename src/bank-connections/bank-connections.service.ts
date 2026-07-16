import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  BankConnectionStatus,
  CategoryType,
  ExpenseNature,
  PluggyConnectionAttemptStatus,
  Prisma,
  TransactionSource,
  TransactionStatus,
  TransactionType,
  WebhookEventStatus,
} from '@prisma/client';
import { waitUntil } from '@vercel/functions';
import { timingSafeEqual } from 'node:crypto';
import { money } from '../finance/finance.utils';
import { PrismaService } from '../infrastructure/prisma/prisma.service';

type PluggyItem = {
  id: string;
  clientUserId?: string;
  status?: string;
  executionStatus?: string;
  lastUpdatedAt?: string;
  error?: { code?: string; message?: string } | null;
  connector?: {
    id?: number;
    name?: string;
    imageUrl?: string;
    primaryColor?: string;
  };
  connectorId?: number;
};

type PluggyAccount = {
  id: string;
  name?: string;
  type?: string;
  subtype?: string;
  currencyCode?: string;
  balance?: number;
  number?: string;
};

type PluggyConnector = {
  id: number;
  name: string;
};

type PluggyTransaction = {
  id: string;
  date: string;
  description: string;
  amount: number;
  type: 'DEBIT' | 'CREDIT';
  status: 'PENDING' | 'POSTED';
  category?: string | null;
  categoryId?: string | null;
  merchant?: { name?: string } | null;
};

type PluggyWebhook = {
  event?: string;
  eventId?: string;
  id?: string;
  itemId?: string;
  accountId?: string;
  clientUserId?: string;
  transactionIds?: string[];
  error?: { code?: string };
};

@Injectable()
export class BankConnectionsService {
  private static readonly meuPluggyProvider = 'MEU_PLUGGY';
  private static readonly connectorCacheTtlMs = 6 * 60 * 60 * 1000;
  private static readonly connectTokenTtlMs = 30 * 60 * 1000;
  private readonly apiUrl =
    process.env.PLUGGY_API_URL ?? 'https://api.pluggy.ai';
  private readonly logger = new Logger(BankConnectionsService.name);
  private apiKey: { value: string; expiresAt: number } | null = null;
  private meuPluggyConnector: { id: number; expiresAt: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    const connections = await this.prisma.bankConnection.findMany({
      where: { userId },
      include: { accounts: true },
      orderBy: { createdAt: 'desc' },
    });
    return connections.map((connection) => ({
      ...connection,
      accountCount: connection.accounts.length,
      accounts: connection.accounts.map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type,
        subtype: account.subtype,
        balance: money(account.balance),
        currency: account.currency,
        numberLastFour: account.numberLastFour,
      })),
    }));
  }

  async createConnectToken(userId: string, connectionId?: string) {
    let itemId: string | undefined;
    let bankConnectionId: string | undefined;
    if (connectionId) {
      const connection = await this.findOwned(userId, connectionId);
      itemId = connection.externalItemId;
      bankConnectionId = connection.id;
    }

    const connectorId = await this.getMeuPluggyConnectorId();
    const attempt = await this.prisma.pluggyConnectionAttempt.create({
      data: {
        userId,
        bankConnectionId,
        expectedItemId: itemId,
        expiresAt: new Date(
          Date.now() + BankConnectionsService.connectTokenTtlMs,
        ),
      },
    });
    const isUpdate = Boolean(itemId);
    const body: Record<string, unknown> = {
      options: {
        avoidDuplicates: true,
        // clientUserId identifies newly created Items. Updating an Item must
        // preserve its original ownership reference instead of replacing it.
        ...(!isUpdate ? { clientUserId: attempt.id } : {}),
      },
      ...(isUpdate ? { itemId } : {}),
    };
    let token: { accessToken?: string };
    try {
      token = await this.pluggyRequest<{ accessToken?: string }>(
        '/connect_token',
        { method: 'POST', body: JSON.stringify(body) },
      );
      if (!token.accessToken) {
        throw new BadGatewayException('Pluggy did not return a connect token');
      }
    } catch (error) {
      await this.prisma.pluggyConnectionAttempt.update({
        where: { id: attempt.id },
        data: {
          status: PluggyConnectionAttemptStatus.FAILED,
          errorCode: 'CONNECT_TOKEN_ERROR',
        },
      });
      throw error;
    }
    this.logger.log(
      JSON.stringify({
        event: 'pluggy_connection_attempt_started',
        attemptId: attempt.id,
        userId,
        reconnect: Boolean(connectionId),
      }),
    );
    return {
      accessToken: token.accessToken,
      connectorId,
      attemptId: attempt.id,
      mode: isUpdate ? ('UPDATE' as const) : ('CREATE' as const),
      ...(itemId ? { updateItemId: itemId } : {}),
    };
  }

  async reportConnectionAttemptError(
    userId: string,
    input: {
      attemptId: string;
      code: string;
      message: string;
      itemId?: string;
      occurredAt: string;
    },
  ) {
    const attempt = await this.findOwnedAttempt(userId, input.attemptId);
    await this.assertAttemptPending(attempt);
    let connectionPreserved = false;
    let connectionId = attempt.bankConnectionId;

    if (input.itemId) {
      const item = await this.pluggyRequest<PluggyItem>(
        `/items/${input.itemId}`,
      );
      await this.assertAttemptOwnsItem(userId, attempt, item);
      const existing = await this.prisma.bankConnection.findUnique({
        where: { externalItemId: input.itemId },
      });
      if (existing && existing.userId !== userId) {
        throw new UnauthorizedException(
          'This bank connection belongs to another user',
        );
      }
      const connection = await this.upsertConnection(userId, item);
      connectionId = connection.id;
      await this.prisma.bankConnection.update({
        where: { id: connection.id },
        data: {
          status: BankConnectionStatus.ERROR,
          errorCode: input.code,
        },
      });
      connectionPreserved = true;
    }

    await this.prisma.pluggyConnectionAttempt.update({
      where: { id: attempt.id },
      data: {
        bankConnectionId: connectionId,
        resultItemId: input.itemId,
        status: PluggyConnectionAttemptStatus.FAILED,
        errorCode: input.code,
      },
    });

    this.logger.warn(
      JSON.stringify({
        event: 'pluggy_connection_attempt_error',
        attemptId: input.attemptId,
        userId,
        code: input.code,
        itemId: input.itemId ?? null,
        occurredAt: input.occurredAt,
        connectionPreserved,
      }),
    );

    return { accepted: true as const };
  }

  async completeConnection(userId: string, attemptId: string, itemId: string) {
    const attempt = await this.findOwnedAttempt(userId, attemptId);
    if (attempt.status === PluggyConnectionAttemptStatus.COMPLETED) {
      if (attempt.resultItemId !== itemId) {
        throw new ConflictException('Connection attempt already completed');
      }
      return this.findCompletedConnection(userId, itemId);
    }
    await this.assertAttemptPending(attempt);
    this.assertExpectedItem(attempt.expectedItemId, itemId);
    const item = await this.pluggyRequest<PluggyItem>(`/items/${itemId}`);
    await this.assertAttemptOwnsItem(userId, attempt, item);
    const existing = await this.prisma.bankConnection.findUnique({
      where: { externalItemId: itemId },
    });
    if (existing && existing.userId !== userId) {
      throw new UnauthorizedException(
        'This bank connection belongs to another user',
      );
    }

    const claimed = await this.prisma.pluggyConnectionAttempt.updateMany({
      where: {
        id: attempt.id,
        userId,
        status: PluggyConnectionAttemptStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      data: {
        status: PluggyConnectionAttemptStatus.PROCESSING,
        resultItemId: itemId,
      },
    });
    if (claimed.count === 0) {
      const current = await this.findOwnedAttempt(userId, attempt.id);
      if (
        current.status === PluggyConnectionAttemptStatus.COMPLETED &&
        current.resultItemId === itemId
      ) {
        return this.findCompletedConnection(userId, itemId);
      }
      throw new ConflictException('Connection attempt is already in progress');
    }

    try {
      const connection = await this.upsertConnection(userId, item);
      await this.syncItem(
        userId,
        itemId,
        attempt.expectedItemId ? undefined : attempt.id,
      );
      await this.prisma.pluggyConnectionAttempt.update({
        where: { id: attempt.id },
        data: {
          bankConnectionId: connection.id,
          resultItemId: itemId,
          status: PluggyConnectionAttemptStatus.COMPLETED,
          completedAt: new Date(),
          errorCode: null,
        },
      });
      return this.findCompletedConnection(userId, itemId);
    } catch (error) {
      await this.prisma.pluggyConnectionAttempt.update({
        where: { id: attempt.id },
        data: {
          status: PluggyConnectionAttemptStatus.FAILED,
          errorCode: this.errorCode(error),
        },
      });
      throw error;
    }
  }

  async sync(userId: string, id: string) {
    const connection = await this.findOwned(userId, id);
    await this.syncItem(userId, connection.externalItemId);
    this.scheduleBackground(() => this.processPendingWebhooks());
    return { synced: true, syncedAt: new Date() };
  }

  async disconnect(userId: string, id: string) {
    const connection = await this.findOwned(userId, id);
    try {
      await this.pluggyRequest(`/items/${connection.externalItemId}`, {
        method: 'DELETE',
      });
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }
    await this.prisma.bankConnection.update({
      where: { id },
      data: { status: BankConnectionStatus.DISCONNECTED },
    });
    return { disconnected: true, historicalDataPreserved: true };
  }

  async deleteImportedData(userId: string, id: string) {
    const connection = await this.findOwned(userId, id);
    if (connection.status !== BankConnectionStatus.DISCONNECTED) {
      throw new BadRequestException(
        'Disconnect Meu Pluggy before deleting imported data',
      );
    }

    const accounts = await this.prisma.bankAccount.findMany({
      where: { userId, bankConnectionId: id },
      select: { id: true },
    });
    const accountIds = accounts.map((account) => account.id);
    const deletedTransactions = accountIds.length
      ? await this.prisma.transaction.deleteMany({
          where: {
            userId,
            source: TransactionSource.PLUGGY,
            bankAccountId: { in: accountIds },
          },
        })
      : { count: 0 };
    const deletedAccounts = await this.prisma.bankAccount.deleteMany({
      where: { userId, bankConnectionId: id },
    });
    await this.prisma.bankConnection.update({
      where: { id },
      data: { lastSyncedAt: null },
    });

    return {
      deleted: true,
      transactions: deletedTransactions.count,
      accounts: deletedAccounts.count,
    };
  }

  async enqueueWebhook(secret: string | undefined, rawPayload: unknown) {
    this.assertWebhookSecret(secret);
    if (!rawPayload || typeof rawPayload !== 'object') {
      throw new BadRequestException('Invalid webhook payload');
    }
    const payload = rawPayload as PluggyWebhook;
    const externalId = payload.eventId ?? payload.id;
    if (!externalId || !payload.event) {
      throw new BadRequestException('Webhook eventId and event are required');
    }
    this.logger.log(
      JSON.stringify({
        event: 'pluggy_webhook_received',
        webhookEvent: payload.event,
        externalId,
        itemId: payload.itemId ?? null,
        clientUserId: payload.clientUserId ?? null,
      }),
    );
    try {
      await this.prisma.webhookEvent.create({
        data: {
          externalId,
          event: payload.event,
          payload: payload,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        this.scheduleWebhookProcessing(externalId);
        return { accepted: true, duplicate: true };
      }
      throw error;
    }
    this.scheduleWebhookProcessing(externalId);
    return { accepted: true, duplicate: false };
  }

  async processPendingWebhooks() {
    const staleProcessingThreshold = new Date(Date.now() - 10 * 60 * 1000);
    await this.prisma.webhookEvent.updateMany({
      where: {
        status: WebhookEventStatus.PROCESSING,
        updatedAt: { lt: staleProcessingThreshold },
      },
      data: {
        status: WebhookEventStatus.FAILED,
        lastError: 'Processing timed out before completion',
      },
    });

    const events = await this.prisma.webhookEvent.findMany({
      where: {
        status: { in: [WebhookEventStatus.PENDING, WebhookEventStatus.FAILED] },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    await Promise.all(
      events.map((event) => this.processWebhook(event.externalId)),
    );
    return { processed: events.length };
  }

  async recoverPendingWebhooks(authorization: string | undefined) {
    const received = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : undefined;
    this.assertSecret(process.env.CRON_SECRET, received, 'Invalid cron secret');
    return this.processPendingWebhooks();
  }

  private async processWebhook(externalId: string) {
    const claim = await this.prisma.webhookEvent.updateMany({
      where: {
        externalId,
        status: {
          in: [WebhookEventStatus.PENDING, WebhookEventStatus.FAILED],
        },
      },
      data: {
        status: WebhookEventStatus.PROCESSING,
        attempts: { increment: 1 },
      },
    });
    if (claim.count === 0) return;

    const event = await this.prisma.webhookEvent.findUnique({
      where: { externalId },
    });
    if (!event) return;
    const payload = event.payload as PluggyWebhook;
    try {
      if (event.event === 'item/deleted' && payload.itemId) {
        await this.prisma.bankConnection.updateMany({
          where: { externalItemId: payload.itemId },
          data: {
            status: BankConnectionStatus.DISCONNECTED,
            errorCode: null,
          },
        });
      } else if (
        event.event === 'transactions/deleted' &&
        payload.transactionIds &&
        payload.accountId
      ) {
        await this.prisma.transaction.deleteMany({
          where: {
            source: TransactionSource.PLUGGY,
            externalId: { in: payload.transactionIds },
            bankAccount: { externalAccountId: payload.accountId },
          },
        });
      } else if (payload.itemId) {
        const existing = await this.prisma.bankConnection.findUnique({
          where: { externalItemId: payload.itemId },
        });
        const item = await this.pluggyRequest<PluggyItem>(
          `/items/${payload.itemId}`,
        );
        const owner = await this.resolveWebhookOwner(item, payload, existing);
        if (owner) {
          const connection = await this.upsertConnection(owner.userId, item);
          if (event.event === 'item/error') {
            const errorCode =
              payload.error?.code ??
              item.error?.code ??
              item.executionStatus ??
              'ERROR';
            await this.prisma.bankConnection.update({
              where: { id: connection.id },
              data: {
                status: BankConnectionStatus.ERROR,
                errorCode,
              },
            });
            if (owner.attemptId) {
              await this.prisma.pluggyConnectionAttempt.updateMany({
                where: {
                  id: owner.attemptId,
                  status: {
                    in: [
                      PluggyConnectionAttemptStatus.PENDING,
                      PluggyConnectionAttemptStatus.PROCESSING,
                    ],
                  },
                },
                data: {
                  bankConnectionId: connection.id,
                  resultItemId: item.id,
                  status: PluggyConnectionAttemptStatus.FAILED,
                  errorCode,
                },
              });
            }
          } else if (
            !event.event.startsWith('item/waiting_') &&
            item.status !== 'UPDATING' &&
            !item.executionStatus?.endsWith('_IN_PROGRESS')
          ) {
            await this.syncItem(owner.userId, payload.itemId, owner.attemptId);
          }
        } else {
          this.logger.warn(
            JSON.stringify({
              event: 'pluggy_webhook_missing_owner',
              webhookEvent: event.event,
              externalId,
              itemId: payload.itemId,
            }),
          );
        }
      }
      await this.prisma.webhookEvent.update({
        where: { externalId },
        data: {
          status: WebhookEventStatus.PROCESSED,
          processedAt: new Date(),
          lastError: null,
        },
      });
    } catch (error) {
      await this.prisma.webhookEvent.update({
        where: { externalId },
        data: {
          status: WebhookEventStatus.FAILED,
          lastError:
            error instanceof Error
              ? error.message.slice(0, 500)
              : 'Unknown error',
        },
      });
    }
  }

  private async syncItem(
    userId: string,
    itemId: string,
    expectedClientUserId?: string,
  ) {
    const item = await this.pluggyRequest<PluggyItem>(`/items/${itemId}`);
    if (expectedClientUserId) {
      this.assertItemAttempt(item, expectedClientUserId);
    } else {
      const owned = await this.prisma.bankConnection.findFirst({
        where: { externalItemId: itemId, userId },
      });
      if (!owned) {
        throw new UnauthorizedException('Connection ownership mismatch');
      }
    }
    const connection = await this.upsertConnection(userId, item);
    const accountsResponse = await this.pluggyRequest<{
      results?: PluggyAccount[];
    }>(`/accounts?itemId=${encodeURIComponent(itemId)}`);
    const accounts = accountsResponse.results ?? [];
    const accountIds = accounts.map((account) => account.id);
    const duplicateAccount = accountIds.length
      ? await this.prisma.bankAccount.findFirst({
          where: {
            externalAccountId: { in: accountIds },
            bankConnectionId: { not: connection.id },
          },
        })
      : null;
    if (duplicateAccount) {
      await this.prisma.bankConnection.update({
        where: { id: connection.id },
        data: {
          status: BankConnectionStatus.ERROR,
          errorCode: 'DUPLICATE_BANK_ACCOUNT',
        },
      });
      throw new ConflictException(
        'Esta conta bancária já foi importada por outra conexão do Gatekeep.',
      );
    }

    for (const account of accounts) {
      const savedAccount = await this.prisma.bankAccount.upsert({
        where: { externalAccountId: account.id },
        update: {
          name: account.name ?? 'Conta bancária',
          type: account.type ?? 'BANK',
          subtype: account.subtype ?? null,
          currency: account.currencyCode ?? 'BRL',
          balance:
            account.balance === undefined
              ? null
              : new Prisma.Decimal(account.balance),
          numberLastFour: account.number?.slice(-4) ?? null,
        },
        create: {
          userId,
          bankConnectionId: connection.id,
          externalAccountId: account.id,
          name: account.name ?? 'Conta bancária',
          type: account.type ?? 'BANK',
          subtype: account.subtype ?? null,
          currency: account.currencyCode ?? 'BRL',
          balance:
            account.balance === undefined
              ? null
              : new Prisma.Decimal(account.balance),
          numberLastFour: account.number?.slice(-4) ?? null,
        },
      });
      await this.syncTransactions(userId, savedAccount.id, account.id);
    }
    await this.prisma.bankConnection.update({
      where: { id: connection.id },
      data: { lastSyncedAt: new Date(), errorCode: null },
    });
  }

  private async syncTransactions(
    userId: string,
    bankAccountId: string,
    accountId: string,
  ) {
    let path: string | null =
      `/v2/transactions?accountId=${encodeURIComponent(accountId)}`;
    const categories = await this.prisma.category.findMany({
      where: { userId, isActive: true },
    });
    while (path) {
      const page: { results?: PluggyTransaction[]; next?: string | null } =
        await this.pluggyRequest(path);
      for (const transaction of page.results ?? []) {
        const type =
          transaction.type === 'DEBIT'
            ? TransactionType.EXPENSE
            : TransactionType.INCOME;
        const category = this.mapCategory(
          transaction.category,
          type,
          categories,
        );
        await this.prisma.transaction.upsert({
          where: {
            bankAccountId_externalId: {
              bankAccountId,
              externalId: transaction.id,
            },
          },
          update: {
            type,
            status:
              transaction.status === 'PENDING'
                ? TransactionStatus.PENDING
                : TransactionStatus.POSTED,
            title: transaction.merchant?.name ?? transaction.description,
            description: transaction.description,
            amount: new Prisma.Decimal(Math.abs(transaction.amount)),
            transactionDate: new Date(transaction.date),
            providerCategoryId: transaction.categoryId ?? null,
            providerCategoryName: transaction.category ?? null,
          },
          create: {
            userId,
            bankAccountId,
            categoryId: category?.id ?? null,
            type,
            source: TransactionSource.PLUGGY,
            nature:
              type === TransactionType.EXPENSE ? ExpenseNature.VARIABLE : null,
            status:
              transaction.status === 'PENDING'
                ? TransactionStatus.PENDING
                : TransactionStatus.POSTED,
            title: transaction.merchant?.name ?? transaction.description,
            description: transaction.description,
            amount: new Prisma.Decimal(Math.abs(transaction.amount)),
            transactionDate: new Date(transaction.date),
            externalId: transaction.id,
            providerCategoryId: transaction.categoryId ?? null,
            providerCategoryName: transaction.category ?? null,
          },
        });
      }
      path = page.next ? this.normalizeNextPath(page.next) : null;
    }
  }

  private mapCategory(
    providerName: string | null | undefined,
    type: TransactionType,
    categories: { id: string; name: string; type: CategoryType }[],
  ) {
    if (type === TransactionType.INCOME) {
      return categories.find(
        (category) => category.type === CategoryType.INCOME,
      );
    }
    const name = providerName?.toLocaleLowerCase('pt-BR') ?? '';
    if (!name) return undefined;
    const mapping: [RegExp, string][] = [
      [/restaurant|food|mercado|aliment|grocer/, 'Alimentação'],
      [/transport|gas station|fuel|uber|taxi/, 'Transporte'],
      [/health|medical|pharma|saúde/, 'Saúde'],
      [/education|school|book|educa/, 'Outros'],
      [/stream|subscription|assinatura/, 'Assinaturas'],
      [/rent|house|utilities|moradia|home/, 'Moradia'],
      [/tax|fee|imposto|taxa/, 'Outros'],
      [/shop|retail|compra/, 'Compras'],
      [/entertainment|leisure|lazer/, 'Outros'],
    ];
    const target = mapping.find(([pattern]) => pattern.test(name))?.[1];
    if (!target) return undefined;
    return categories.find(
      (category) =>
        category.type === CategoryType.EXPENSE && category.name === target,
    );
  }

  private async upsertConnection(userId: string, item: PluggyItem) {
    return this.prisma.bankConnection.upsert({
      where: { externalItemId: item.id },
      update: {
        provider: BankConnectionsService.meuPluggyProvider,
        connectorId: item.connector?.id ?? item.connectorId ?? null,
        institutionName: item.connector?.name ?? null,
        institutionLogoUrl: item.connector?.imageUrl ?? null,
        status: this.mapConnectionStatus(item),
        errorCode: item.error?.code ?? null,
      },
      create: {
        userId,
        provider: BankConnectionsService.meuPluggyProvider,
        externalItemId: item.id,
        connectorId: item.connector?.id ?? item.connectorId ?? null,
        institutionName: item.connector?.name ?? null,
        institutionLogoUrl: item.connector?.imageUrl ?? null,
        status: this.mapConnectionStatus(item),
        errorCode: item.error?.code ?? null,
      },
    });
  }

  private mapConnectionStatus(item: PluggyItem) {
    const status = item.executionStatus ?? item.status;
    if (status === 'SUCCESS' || status === 'PARTIAL_SUCCESS')
      return BankConnectionStatus.ACTIVE;
    if (status?.startsWith('WAITING'))
      return BankConnectionStatus.WAITING_USER_INPUT;
    if (status === 'USER_AUTHORIZATION_PENDING')
      return BankConnectionStatus.WAITING_USER_INPUT;
    if (status === 'USER_AUTHORIZATION_REVOKED')
      return BankConnectionStatus.DISCONNECTED;
    if (status === 'ERROR' || status === 'LOGIN_ERROR' || status === 'OUTDATED')
      return BankConnectionStatus.ERROR;
    return BankConnectionStatus.CONNECTING;
  }

  private async findOwnedAttempt(userId: string, attemptId: string) {
    const attempt = await this.prisma.pluggyConnectionAttempt.findFirst({
      where: { id: attemptId, userId },
    });
    if (!attempt) {
      throw new NotFoundException('Connection attempt not found');
    }
    return attempt;
  }

  private async assertAttemptPending(attempt: {
    id: string;
    status: PluggyConnectionAttemptStatus;
    expiresAt: Date;
  }) {
    if (attempt.expiresAt.getTime() <= Date.now()) {
      await this.prisma.pluggyConnectionAttempt.updateMany({
        where: {
          id: attempt.id,
          status: PluggyConnectionAttemptStatus.PENDING,
        },
        data: { status: PluggyConnectionAttemptStatus.EXPIRED },
      });
      throw new BadRequestException('Connection attempt expired');
    }
    if (attempt.status !== PluggyConnectionAttemptStatus.PENDING) {
      throw new ConflictException('Connection attempt is no longer available');
    }
  }

  private assertItemAttempt(item: PluggyItem, attemptId: string) {
    if (item.clientUserId !== attemptId) {
      throw new UnauthorizedException('Connection ownership mismatch');
    }
  }

  private assertExpectedItem(expectedItemId: string | null, itemId: string) {
    if (expectedItemId && expectedItemId !== itemId) {
      throw new UnauthorizedException('Connection item does not match attempt');
    }
  }

  private async assertAttemptOwnsItem(
    userId: string,
    attempt: {
      id: string;
      bankConnectionId: string | null;
      expectedItemId: string | null;
    },
    item: PluggyItem,
  ) {
    this.assertExpectedItem(attempt.expectedItemId, item.id);
    if (!attempt.expectedItemId) {
      this.assertItemAttempt(item, attempt.id);
      return;
    }

    if (!attempt.bankConnectionId) {
      throw new UnauthorizedException('Connection ownership mismatch');
    }
    const connection = await this.prisma.bankConnection.findFirst({
      where: {
        id: attempt.bankConnectionId,
        userId,
        externalItemId: item.id,
      },
    });
    if (!connection) {
      throw new UnauthorizedException('Connection ownership mismatch');
    }
  }

  private async findCompletedConnection(userId: string, itemId: string) {
    const connection = await this.prisma.bankConnection.findUnique({
      where: { externalItemId: itemId },
      include: { accounts: true },
    });
    if (!connection || connection.userId !== userId) {
      throw new NotFoundException('Bank connection not found');
    }
    return { ...connection, accountCount: connection.accounts.length };
  }

  private async resolveWebhookOwner(
    item: PluggyItem,
    payload: PluggyWebhook,
    existing: { userId: string } | null,
  ) {
    if (payload.itemId !== item.id) {
      throw new UnauthorizedException('Webhook item mismatch');
    }
    const reference = item.clientUserId;
    if (existing) {
      if (reference && this.isUuid(reference)) {
        const attempt = await this.prisma.pluggyConnectionAttempt.findUnique({
          where: { id: reference },
        });
        if (attempt && attempt.userId !== existing.userId) {
          throw new UnauthorizedException('Connection ownership mismatch');
        }
      }
      return { userId: existing.userId, attemptId: undefined };
    }

    if (reference && this.isUuid(reference)) {
      const attempt = await this.prisma.pluggyConnectionAttempt.findUnique({
        where: { id: reference },
      });
      if (attempt) {
        this.assertItemAttempt(item, attempt.id);
        const activeAttempt =
          attempt.expiresAt.getTime() > Date.now() &&
          (attempt.status === PluggyConnectionAttemptStatus.PENDING ||
            attempt.status === PluggyConnectionAttemptStatus.PROCESSING);
        if (!existing && !activeAttempt) {
          if (
            attempt.expiresAt.getTime() <= Date.now() &&
            attempt.status === PluggyConnectionAttemptStatus.PENDING
          ) {
            await this.prisma.pluggyConnectionAttempt.updateMany({
              where: {
                id: attempt.id,
                status: PluggyConnectionAttemptStatus.PENDING,
              },
              data: { status: PluggyConnectionAttemptStatus.EXPIRED },
            });
          }
          return null;
        }
        return { userId: attempt.userId, attemptId: attempt.id };
      }
    }
    return null;
  }

  private isUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  private errorCode(error: unknown) {
    if (error instanceof ConflictException) return 'DUPLICATE_BANK_ACCOUNT';
    if (error instanceof UnauthorizedException) return 'OWNERSHIP_MISMATCH';
    return 'CONNECTION_COMPLETION_ERROR';
  }

  private async findOwned(userId: string, id: string) {
    const connection = await this.prisma.bankConnection.findFirst({
      where: { id, userId },
    });
    if (!connection) throw new NotFoundException('Bank connection not found');
    return connection;
  }

  private async pluggyRequest<T = unknown>(
    path: string,
    init: RequestInit = {},
  ) {
    const apiKey = await this.getApiKey();
    const url = path.startsWith('http') ? path : `${this.apiUrl}${path}`;
    const response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
        ...init.headers,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404)
      throw new NotFoundException('Pluggy resource not found');
    if (!response.ok) {
      const payload = await this.readPluggyError(response);
      if (
        payload.code === 'ITEM_USER_ALREADY_EXISTS' ||
        payload.code === 'ITEM_USER_ALREADY_EXIST'
      ) {
        throw new BadRequestException(
          'A Pluggy informou que estas credenciais já possuem uma conexão ativa. Confirme se você está reconectando o banco existente; se o erro persistir, contate o suporte da Pluggy.',
        );
      }
      if (payload.code === 'TRIAL_CLIENT_ITEM_CREATE_NOT_ALLOWED') {
        throw new ServiceUnavailableException(
          'A aplicação Pluggy ainda não está liberada para criar conexões Meu Pluggy.',
        );
      }
      const resource = new URL(url).pathname.replace(
        /\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,
        '/:id',
      );
      this.logger.warn(
        `Pluggy ${init.method ?? 'GET'} ${resource} failed with ${response.status}${payload.code ? ` (${payload.code})` : ''}${payload.message ? `: ${payload.message}` : ''}`,
      );
      throw new BadGatewayException(
        `Pluggy request failed with ${response.status} on ${resource}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async getApiKey() {
    if (this.apiKey && this.apiKey.expiresAt > Date.now())
      return this.apiKey.value;
    const clientId = process.env.PLUGGY_CLIENT_ID;
    const clientSecret = process.env.PLUGGY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new ServiceUnavailableException(
        'Pluggy integration is not configured',
      );
    }
    const response = await fetch(`${this.apiUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new BadGatewayException('Could not authenticate with Pluggy');
    const data = (await response.json()) as { apiKey?: string };
    if (!data.apiKey)
      throw new BadGatewayException('Pluggy did not return an API key');
    this.apiKey = {
      value: data.apiKey,
      expiresAt: Date.now() + 110 * 60 * 1000,
    };
    return data.apiKey;
  }

  private async getMeuPluggyConnectorId() {
    if (
      this.meuPluggyConnector &&
      this.meuPluggyConnector.expiresAt > Date.now()
    ) {
      return this.meuPluggyConnector.id;
    }

    const response = await this.pluggyRequest<
      PluggyConnector[] | { results?: PluggyConnector[] }
    >('/connectors');
    const connectors = Array.isArray(response)
      ? response
      : (response.results ?? []);
    const connector = connectors.find(
      ({ name }) =>
        name.replaceAll(/\s/g, '').toLocaleLowerCase('pt-BR') === 'meupluggy',
    );
    if (!connector) {
      throw new ServiceUnavailableException(
        'O conector Meu Pluggy não está habilitado nesta aplicação.',
      );
    }

    this.meuPluggyConnector = {
      id: connector.id,
      expiresAt: Date.now() + BankConnectionsService.connectorCacheTtlMs,
    };
    return connector.id;
  }

  private async readPluggyError(response: Response) {
    try {
      const payload = (await response.json()) as {
        code?: string | number;
        codeDescription?: string;
        message?: string;
      };
      const code = payload.code ?? payload.codeDescription ?? null;
      return {
        code: code === null ? null : String(code),
        message: payload.message?.slice(0, 200) ?? null,
      };
    } catch {
      return { code: null, message: null };
    }
  }

  private assertWebhookSecret(received: string | undefined) {
    this.assertSecret(
      process.env.PLUGGY_WEBHOOK_SECRET,
      received,
      'Invalid webhook secret',
    );
  }

  private assertSecret(
    expected: string | undefined,
    received: string | undefined,
    message: string,
  ) {
    if (!expected || !received) throw new UnauthorizedException(message);
    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(received);
    if (
      expectedBuffer.length !== receivedBuffer.length ||
      !timingSafeEqual(expectedBuffer, receivedBuffer)
    ) {
      throw new UnauthorizedException(message);
    }
  }

  private scheduleWebhookProcessing(externalId: string) {
    this.scheduleBackground(async () => {
      await this.processWebhook(externalId);
      await this.processPendingWebhooks();
    });
  }

  private scheduleBackground(task: () => Promise<unknown>) {
    if (process.env.NODE_ENV === 'test') return;
    const backgroundTask = task().catch((error: unknown) => {
      this.logger.error(
        'Background webhook processing failed',
        error instanceof Error ? error.stack : undefined,
      );
    });

    if (process.env.VERCEL) {
      waitUntil(backgroundTask);
    }
  }

  private normalizeNextPath(next: string) {
    if (!next.startsWith('http'))
      return next.startsWith('/') ? next : `/v2/transactions${next}`;
    const url = new URL(next);
    return `${url.pathname}${url.search}`;
  }
}
