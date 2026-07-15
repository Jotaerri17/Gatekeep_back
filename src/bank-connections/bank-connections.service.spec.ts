import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
  BankConnectionStatus,
  CategoryType,
  TransactionSource,
  TransactionType,
  WebhookEventStatus,
} from '@prisma/client';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { BankConnectionsService } from './bank-connections.service';

type PrivateBankConnectionsService = {
  processWebhook(externalId: string): Promise<void>;
  mapCategory(
    providerName: string,
    type: TransactionType,
    categories: { id: string; name: string; type: CategoryType }[],
  ): { id: string; name: string; type: CategoryType } | undefined;
};

describe('BankConnectionsService', () => {
  const prisma = {
    bankConnection: {
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    bankAccount: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    transaction: {
      deleteMany: jest.fn(),
    },
    webhookEvent: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  let service: BankConnectionsService;
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BankConnectionsService(prisma as unknown as PrismaService);
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    process.env.PLUGGY_CLIENT_ID = 'client-id';
    process.env.PLUGGY_CLIENT_SECRET = 'client-secret';
  });

  it('creates a token restricted to the MeuPluggy connector', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ apiKey: 'api-key' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              { id: 1, name: 'Other' },
              { id: 42, name: 'Meu Pluggy' },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'connect-token' }), {
          status: 200,
        }),
      );

    await expect(service.createConnectToken('user-id')).resolves.toEqual({
      accessToken: 'connect-token',
      connectorId: 42,
    });

    const connectRequest = fetchMock.mock.calls[2];
    expect(connectRequest[0]).toBe('https://api.pluggy.ai/connect_token');
    const requestBody = connectRequest[1]?.body;
    if (typeof requestBody !== 'string')
      throw new Error('Expected a JSON request body');
    const parsedBody: unknown = JSON.parse(requestBody);
    expect(parsedBody).toEqual({
      options: {
        clientUserId: 'user-id',
        avoidDuplicates: true,
      },
    });
  });

  it('explains how to recover when Pluggy finds an existing shared bank', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ apiKey: 'api-key' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ id: 42, name: 'Meu Pluggy' }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'ITEM_USER_ALREADY_EXISTS' }), {
          status: 400,
        }),
      );

    await expect(service.createConnectToken('user-id')).rejects.toThrow(
      'No Meu Pluggy, revogue o acesso do Gatekeep para este banco',
    );
  });

  it('marks a connection as disconnected when Meu Pluggy revokes it', async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue({
      externalId: 'event-id',
      event: 'item/deleted',
      status: WebhookEventStatus.PENDING,
      payload: { itemId: 'item-id' },
    });
    prisma.webhookEvent.update.mockResolvedValue({});
    prisma.webhookEvent.updateMany.mockResolvedValue({ count: 1 });
    prisma.bankConnection.updateMany.mockResolvedValue({ count: 1 });

    await (service as unknown as PrivateBankConnectionsService).processWebhook(
      'event-id',
    );

    expect(prisma.bankConnection.updateMany).toHaveBeenCalledWith({
      where: { externalItemId: 'item-id' },
      data: {
        status: BankConnectionStatus.DISCONNECTED,
        errorCode: null,
      },
    });
    expect(prisma.webhookEvent.update).toHaveBeenLastCalledWith({
      where: { externalId: 'event-id' },
      data: {
        status: WebhookEventStatus.PROCESSED,
        processedAt: expect.any(Date) as Date,
        lastError: null,
      },
    });
  });

  it('deletes imported data only after the connection is disconnected', async () => {
    prisma.bankConnection.findFirst.mockResolvedValue({
      id: 'connection-id',
      userId: 'user-id',
      status: BankConnectionStatus.DISCONNECTED,
    });
    prisma.bankAccount.findMany.mockResolvedValue([
      { id: 'account-1' },
      { id: 'account-2' },
    ]);
    prisma.transaction.deleteMany.mockResolvedValue({ count: 12 });
    prisma.bankAccount.deleteMany.mockResolvedValue({ count: 2 });
    prisma.bankConnection.update.mockResolvedValue({});

    await expect(
      service.deleteImportedData('user-id', 'connection-id'),
    ).resolves.toEqual({ deleted: true, transactions: 12, accounts: 2 });
    expect(prisma.transaction.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-id',
        source: TransactionSource.PLUGGY,
        bankAccountId: { in: ['account-1', 'account-2'] },
      },
    });
  });

  it('keeps active connection data protected from destructive deletion', async () => {
    prisma.bankConnection.findFirst.mockResolvedValue({
      id: 'connection-id',
      userId: 'user-id',
      status: BankConnectionStatus.ACTIVE,
    });

    await expect(
      service.deleteImportedData('user-id', 'connection-id'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.transaction.deleteMany).not.toHaveBeenCalled();
  });

  it.each(['Education', 'Tax and fees', 'Entertainment'])(
    'maps removed provider category %s to Outros',
    (providerCategory) => {
      const testable = service as unknown as PrivateBankConnectionsService;
      const outros = {
        id: 'category-id',
        name: 'Outros',
        type: CategoryType.EXPENSE,
      };

      expect(
        testable.mapCategory(providerCategory, TransactionType.EXPENSE, [
          outros,
        ]),
      ).toEqual(outros);
    },
  );

  it('rejects webhook recovery without the cron secret', async () => {
    process.env.CRON_SECRET = 'cron-secret';

    await expect(
      service.recoverPendingWebhooks('Bearer wrong-secret'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('recovers pending webhooks with the configured cron secret', async () => {
    process.env.CRON_SECRET = 'cron-secret';
    prisma.webhookEvent.updateMany.mockResolvedValue({ count: 0 });
    prisma.webhookEvent.findMany.mockResolvedValue([]);

    await expect(
      service.recoverPendingWebhooks('Bearer cron-secret'),
    ).resolves.toEqual({ processed: 0 });
  });
});
