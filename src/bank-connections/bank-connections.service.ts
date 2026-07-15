import {
  BadGatewayException,
  BadRequestException,
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
  error?: { code?: string } | null;
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
    if (connectionId) {
      const connection = await this.findOwned(userId, connectionId);
      itemId = connection.externalItemId;
    }

    const connectorId = await this.getMeuPluggyConnectorId();
    const body: Record<string, unknown> = {
      options: {
        clientUserId: userId,
        avoidDuplicates: true,
      },
      ...(itemId ? { itemId } : {}),
    };
    const token = await this.pluggyRequest<{ accessToken?: string }>(
      '/connect_token',
      { method: 'POST', body: JSON.stringify(body) },
    );
    if (!token.accessToken)
      throw new BadGatewayException('Pluggy did not return a connect token');
    return { accessToken: token.accessToken, connectorId };
  }

  async completeConnection(userId: string, itemId: string) {
    const item = await this.pluggyRequest<PluggyItem>(`/items/${itemId}`);
    if (item.clientUserId && item.clientUserId !== userId) {
      throw new UnauthorizedException(
        'This bank connection belongs to another user',
      );
    }
    const existing = await this.prisma.bankConnection.findUnique({
      where: { externalItemId: itemId },
    });
    if (existing && existing.userId !== userId) {
      throw new UnauthorizedException(
        'This bank connection belongs to another user',
      );
    }
    await this.upsertConnection(userId, item);
    await this.syncItem(userId, itemId);
    const connection = await this.prisma.bankConnection.findUniqueOrThrow({
      where: { externalItemId: itemId },
      include: { accounts: true },
    });
    return { ...connection, accountCount: connection.accounts.length };
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
        const userId = existing?.userId ?? payload.clientUserId;
        if (userId) {
          if (event.event === 'item/error') {
            await this.prisma.bankConnection.updateMany({
              where: { externalItemId: payload.itemId, userId },
              data: {
                status: BankConnectionStatus.ERROR,
                errorCode: payload.error?.code ?? null,
              },
            });
          } else {
            await this.syncItem(userId, payload.itemId);
          }
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

  private async syncItem(userId: string, itemId: string) {
    const item = await this.pluggyRequest<PluggyItem>(`/items/${itemId}`);
    if (item.clientUserId && item.clientUserId !== userId) {
      throw new UnauthorizedException('Connection ownership mismatch');
    }
    const connection = await this.upsertConnection(userId, item);
    const accountsResponse = await this.pluggyRequest<{
      results?: PluggyAccount[];
    }>(`/accounts?itemId=${encodeURIComponent(itemId)}`);
    for (const account of accountsResponse.results ?? []) {
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
      if (payload.code === 'ITEM_USER_ALREADY_EXISTS') {
        throw new BadRequestException(
          'Este banco já está conectado ao seu Gatekeep.',
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
