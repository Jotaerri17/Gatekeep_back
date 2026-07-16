import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  BankConnectionStatus,
  CategoryType,
  PluggyConnectionAttemptStatus,
  Prisma,
  TransactionSource,
  TransactionType,
  WebhookEventStatus,
} from '@prisma/client';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { BankConnectionsService } from './bank-connections.service';

type PrivateBankConnectionsService = {
  processWebhook(externalId: string): Promise<void>;
  syncItem(
    userId: string,
    itemId: string,
    expectedClientUserId?: string,
  ): Promise<void>;
  mapCategory(
    providerName: string,
    type: TransactionType,
    categories: { id: string; name: string; type: CategoryType }[],
  ): { id: string; name: string; type: CategoryType } | undefined;
};

const attemptId = 'f3696b1c-a228-43ad-a86c-841b50ab214b';
const itemId = '6d702702-7f0a-43c2-a808-6dc742685840';

describe('BankConnectionsService', () => {
  const prisma = {
    bankConnection: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    bankAccount: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      upsert: jest.fn(),
    },
    pluggyConnectionAttempt: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
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
    const pendingAttempt = {
      id: attemptId,
      userId: 'user-id',
      bankConnectionId: null,
      expectedItemId: null,
      resultItemId: null,
      status: PluggyConnectionAttemptStatus.PENDING,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      completedAt: null,
      errorCode: null,
    };
    prisma.pluggyConnectionAttempt.create.mockResolvedValue(pendingAttempt);
    prisma.pluggyConnectionAttempt.findFirst.mockResolvedValue(pendingAttempt);
    prisma.pluggyConnectionAttempt.findUnique.mockResolvedValue(null);
    prisma.pluggyConnectionAttempt.update.mockResolvedValue(pendingAttempt);
    prisma.pluggyConnectionAttempt.updateMany.mockResolvedValue({ count: 1 });
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
      attemptId,
      mode: 'CREATE',
    });

    expect(prisma.pluggyConnectionAttempt.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-id',
        bankConnectionId: undefined,
        expectedItemId: undefined,
        expiresAt: expect.any(Date) as Date,
      },
    });

    const connectRequest = fetchMock.mock.calls[2];
    expect(connectRequest[0]).toBe('https://api.pluggy.ai/connect_token');
    const requestBody = connectRequest[1]?.body;
    if (typeof requestBody !== 'string')
      throw new Error('Expected a JSON request body');
    const parsedBody: unknown = JSON.parse(requestBody);
    expect(parsedBody).toEqual({
      options: {
        clientUserId: attemptId,
        avoidDuplicates: true,
      },
    });
  });

  it('creates an update token without replacing the Item client user reference', async () => {
    const connectionId = 'connection-id';
    prisma.bankConnection.findFirst.mockResolvedValue({
      id: connectionId,
      userId: 'user-id',
      externalItemId: itemId,
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ apiKey: 'api-key' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ results: [{ id: 42, name: 'Meu Pluggy' }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'update-token' }), {
          status: 200,
        }),
      );

    await expect(
      service.createConnectToken('user-id', connectionId),
    ).resolves.toEqual({
      accessToken: 'update-token',
      connectorId: 42,
      attemptId,
      mode: 'UPDATE',
      updateItemId: itemId,
    });

    expect(prisma.pluggyConnectionAttempt.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-id',
        bankConnectionId: connectionId,
        expectedItemId: itemId,
        expiresAt: expect.any(Date) as Date,
      },
    });
    expect(JSON.parse(fetchMock.mock.calls[2][1]?.body as string)).toEqual({
      options: { avoidDuplicates: true },
      itemId,
    });
  });

  it('creates isolated token references for different users', async () => {
    const secondAttemptId = '4e850c43-fb04-4bd0-8a84-fba6c0bb064b';
    prisma.pluggyConnectionAttempt.create
      .mockResolvedValueOnce({ id: attemptId })
      .mockResolvedValueOnce({ id: secondAttemptId });
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ apiKey: 'api-key' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ results: [{ id: 42, name: 'Meu Pluggy' }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'token-a' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'token-b' }), {
          status: 200,
        }),
      );

    await expect(service.createConnectToken('user-a')).resolves.toMatchObject({
      accessToken: 'token-a',
      attemptId,
    });
    await expect(service.createConnectToken('user-b')).resolves.toMatchObject({
      accessToken: 'token-b',
      attemptId: secondAttemptId,
    });

    const firstBody = JSON.parse(
      fetchMock.mock.calls[2][1]?.body as string,
    ) as { options: { clientUserId: string } };
    const secondBody = JSON.parse(
      fetchMock.mock.calls[3][1]?.body as string,
    ) as { options: { clientUserId: string } };
    expect(firstBody.options.clientUserId).toBe(attemptId);
    expect(secondBody.options.clientUserId).toBe(secondAttemptId);
    expect(firstBody.options.clientUserId).not.toBe(
      secondBody.options.clientUserId,
    );
  });

  it.each(['ITEM_USER_ALREADY_EXISTS', 'ITEM_USER_ALREADY_EXIST'])(
    'explains how to recover when Pluggy returns %s',
    async (code) => {
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
          new Response(JSON.stringify({ code }), {
            status: 400,
          }),
        );

      await expect(service.createConnectToken('user-id')).rejects.toThrow(
        'estas credenciais já possuem uma conexão ativa',
      );
    },
  );

  it('records a connection attempt error without persisting sensitive data', async () => {
    await expect(
      service.reportConnectionAttemptError('user-id', {
        attemptId,
        code: 'ITEM_USER_ALREADY_EXISTS',
        message: 'duplicate',
        occurredAt: '2026-07-15T20:00:00.000Z',
      }),
    ).resolves.toEqual({ accepted: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.bankConnection.upsert).not.toHaveBeenCalled();
    expect(prisma.pluggyConnectionAttempt.update).toHaveBeenCalledWith({
      where: { id: attemptId },
      data: {
        bankConnectionId: null,
        resultItemId: undefined,
        status: PluggyConnectionAttemptStatus.FAILED,
        errorCode: 'ITEM_USER_ALREADY_EXISTS',
      },
    });
  });

  it('accepts an authenticated webhook and queues it without sensitive data', async () => {
    process.env.PLUGGY_WEBHOOK_SECRET = 'webhook-secret';
    prisma.webhookEvent.create.mockResolvedValue({});

    await expect(
      service.enqueueWebhook('webhook-secret', {
        event: 'item/created',
        eventId: 'event-id',
        itemId: 'item-id',
        clientUserId: 'user-id',
      }),
    ).resolves.toEqual({ accepted: true, duplicate: false });

    expect(prisma.webhookEvent.create).toHaveBeenCalledWith({
      data: {
        externalId: 'event-id',
        event: 'item/created',
        payload: {
          event: 'item/created',
          eventId: 'event-id',
          itemId: 'item-id',
          clientUserId: 'user-id',
        },
      },
    });
  });

  it('rejects a webhook with an invalid secret', async () => {
    process.env.PLUGGY_WEBHOOK_SECRET = 'webhook-secret';

    await expect(
      service.enqueueWebhook('wrong-secret', {
        event: 'item/created',
        eventId: 'event-id',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a repeated webhook event idempotently', async () => {
    process.env.PLUGGY_WEBHOOK_SECRET = 'webhook-secret';
    prisma.webhookEvent.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7.8.0',
      }),
    );

    await expect(
      service.enqueueWebhook('webhook-secret', {
        event: 'item/created',
        eventId: 'event-id',
      }),
    ).resolves.toEqual({ accepted: true, duplicate: true });
  });

  it('rejects an error item that belongs to another user', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ apiKey: 'api-key' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'item-id', clientUserId: 'other-user' }),
          { status: 200 },
        ),
      );

    await expect(
      service.reportConnectionAttemptError('user-id', {
        attemptId,
        code: 'UNKNOWN',
        message: 'failed',
        itemId,
        occurredAt: '2026-07-15T20:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.bankConnection.upsert).not.toHaveBeenCalled();
  });

  it('preserves an owned item in error state for reconnection', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ apiKey: 'api-key' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: itemId,
            clientUserId: attemptId,
            connector: { id: 200, name: 'MeuPluggy' },
            status: 'ERROR',
          }),
          { status: 200 },
        ),
      );
    prisma.bankConnection.findUnique.mockResolvedValue(null);
    prisma.bankConnection.upsert.mockResolvedValue({ id: 'connection-id' });
    prisma.bankConnection.update.mockResolvedValue({});

    await expect(
      service.reportConnectionAttemptError('user-id', {
        attemptId,
        code: 'UNKNOWN',
        message: 'failed',
        itemId,
        occurredAt: '2026-07-15T20:00:00.000Z',
      }),
    ).resolves.toEqual({ accepted: true });

    expect(prisma.bankConnection.update).toHaveBeenCalledWith({
      where: { id: 'connection-id' },
      data: {
        status: BankConnectionStatus.ERROR,
        errorCode: 'UNKNOWN',
      },
    });
  });

  it('completes an item only through its authenticated attempt', async () => {
    prisma.bankConnection.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'connection-id',
        userId: 'user-id',
        externalItemId: itemId,
        accounts: [],
      });
    prisma.bankConnection.upsert.mockResolvedValue({ id: 'connection-id' });
    prisma.bankConnection.update.mockResolvedValue({});
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ apiKey: 'api-key' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: itemId,
            clientUserId: attemptId,
            connector: { id: 200, name: 'MeuPluggy' },
            executionStatus: 'SUCCESS',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: itemId,
            clientUserId: attemptId,
            connector: { id: 200, name: 'MeuPluggy' },
            executionStatus: 'SUCCESS',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );

    await expect(
      service.completeConnection('user-id', attemptId, itemId),
    ).resolves.toMatchObject({
      id: 'connection-id',
      userId: 'user-id',
      accountCount: 0,
    });

    expect(prisma.pluggyConnectionAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: attemptId,
        userId: 'user-id',
        status: PluggyConnectionAttemptStatus.PENDING,
        expiresAt: { gt: expect.any(Date) as Date },
      },
      data: {
        status: PluggyConnectionAttemptStatus.PROCESSING,
        resultItemId: itemId,
      },
    });
    expect(prisma.pluggyConnectionAttempt.update).toHaveBeenLastCalledWith({
      where: { id: attemptId },
      data: {
        bankConnectionId: 'connection-id',
        resultItemId: itemId,
        status: PluggyConnectionAttemptStatus.COMPLETED,
        completedAt: expect.any(Date) as Date,
        errorCode: null,
      },
    });
  });

  it('completes a reconnection through the owned expected Item without changing clientUserId', async () => {
    const connection = {
      id: 'connection-id',
      userId: 'user-id',
      externalItemId: itemId,
    };
    prisma.pluggyConnectionAttempt.findFirst.mockResolvedValue({
      id: attemptId,
      userId: 'user-id',
      bankConnectionId: connection.id,
      expectedItemId: itemId,
      resultItemId: null,
      status: PluggyConnectionAttemptStatus.PENDING,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    prisma.bankConnection.findFirst.mockResolvedValue(connection);
    prisma.bankConnection.findUnique
      .mockResolvedValueOnce(connection)
      .mockResolvedValueOnce({ ...connection, accounts: [] });
    prisma.bankConnection.upsert.mockResolvedValue(connection);
    prisma.bankConnection.update.mockResolvedValue({});
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ apiKey: 'api-key' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: itemId,
            clientUserId: 'original-connection-reference',
            connector: { id: 200, name: 'MeuPluggy' },
            executionStatus: 'SUCCESS',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: itemId,
            clientUserId: 'original-connection-reference',
            connector: { id: 200, name: 'MeuPluggy' },
            executionStatus: 'SUCCESS',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );

    await expect(
      service.completeConnection('user-id', attemptId, itemId),
    ).resolves.toMatchObject({ id: connection.id, accountCount: 0 });

    expect(prisma.bankConnection.findFirst).toHaveBeenCalledWith({
      where: {
        id: connection.id,
        userId: 'user-id',
        externalItemId: itemId,
      },
    });
  });

  it('returns an already completed callback idempotently', async () => {
    prisma.pluggyConnectionAttempt.findFirst.mockResolvedValue({
      id: attemptId,
      userId: 'user-id',
      bankConnectionId: 'connection-id',
      expectedItemId: null,
      resultItemId: itemId,
      status: PluggyConnectionAttemptStatus.COMPLETED,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    prisma.bankConnection.findUnique.mockResolvedValue({
      id: 'connection-id',
      userId: 'user-id',
      externalItemId: itemId,
      accounts: [],
    });

    await expect(
      service.completeConnection('user-id', attemptId, itemId),
    ).resolves.toMatchObject({ id: 'connection-id', accountCount: 0 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.bankConnection.upsert).not.toHaveBeenCalled();
  });

  it('does not expose another user connection attempt', async () => {
    prisma.pluggyConnectionAttempt.findFirst.mockResolvedValue(null);

    await expect(
      service.completeConnection('user-b', attemptId, itemId),
    ).rejects.toThrow('Connection attempt not found');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.bankConnection.upsert).not.toHaveBeenCalled();
    expect(prisma.pluggyConnectionAttempt.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an expired connection attempt before reading the item', async () => {
    prisma.pluggyConnectionAttempt.findFirst.mockResolvedValue({
      id: attemptId,
      userId: 'user-id',
      expectedItemId: null,
      resultItemId: null,
      status: PluggyConnectionAttemptStatus.PENDING,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(
      service.completeConnection('user-id', attemptId, itemId),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.pluggyConnectionAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: attemptId,
        status: PluggyConnectionAttemptStatus.PENDING,
      },
      data: { status: PluggyConnectionAttemptStatus.EXPIRED },
    });
  });

  it('rejects an item without the attempt reference', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ apiKey: 'api-key' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: itemId }), { status: 200 }),
      );

    await expect(
      service.completeConnection('user-id', attemptId, itemId),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.pluggyConnectionAttempt.updateMany).not.toHaveBeenCalled();
    expect(prisma.bankConnection.upsert).not.toHaveBeenCalled();
  });

  it('rejects a different item during reconnection', async () => {
    prisma.pluggyConnectionAttempt.findFirst.mockResolvedValue({
      id: attemptId,
      userId: 'user-id',
      expectedItemId: '4e850c43-fb04-4bd0-8a84-fba6c0bb064b',
      resultItemId: null,
      status: PluggyConnectionAttemptStatus.PENDING,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    await expect(
      service.completeConnection('user-id', attemptId, itemId),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(fetchMock).not.toHaveBeenCalled();
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

  it('persists an item error received only through a webhook', async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue({
      externalId: 'event-id',
      event: 'item/error',
      status: WebhookEventStatus.PENDING,
      payload: {
        itemId,
        clientUserId: attemptId,
        error: { code: 'CONNECTION_ERROR' },
      },
    });
    prisma.webhookEvent.updateMany.mockResolvedValue({ count: 1 });
    prisma.bankConnection.findUnique.mockResolvedValue(null);
    prisma.bankConnection.upsert.mockResolvedValue({ id: 'connection-id' });
    prisma.bankConnection.update.mockResolvedValue({});
    prisma.webhookEvent.update.mockResolvedValue({});
    prisma.pluggyConnectionAttempt.findUnique.mockResolvedValue({
      id: attemptId,
      userId: 'user-id',
      status: PluggyConnectionAttemptStatus.PENDING,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ apiKey: 'api-key' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: itemId,
            clientUserId: attemptId,
            connector: { id: 200, name: 'MeuPluggy' },
            status: 'OUTDATED',
            executionStatus: 'CONNECTION_ERROR',
            error: { code: 'CONNECTION_ERROR' },
          }),
          { status: 200 },
        ),
      );

    await (service as unknown as PrivateBankConnectionsService).processWebhook(
      'event-id',
    );

    expect(prisma.bankConnection.upsert).toHaveBeenCalled();
    expect(prisma.bankConnection.update).toHaveBeenCalledWith({
      where: { id: 'connection-id' },
      data: {
        status: BankConnectionStatus.ERROR,
        errorCode: 'CONNECTION_ERROR',
      },
    });
  });

  it('does not create a connection from a webhook without a known attempt', async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue({
      externalId: 'event-id',
      event: 'item/created',
      status: WebhookEventStatus.PENDING,
      payload: { itemId, clientUserId: attemptId },
    });
    prisma.webhookEvent.updateMany.mockResolvedValue({ count: 1 });
    prisma.webhookEvent.update.mockResolvedValue({});
    prisma.bankConnection.findUnique.mockResolvedValue(null);
    prisma.pluggyConnectionAttempt.findUnique.mockResolvedValue(null);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ apiKey: 'api-key' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: itemId, clientUserId: attemptId }), {
          status: 200,
        }),
      );

    await (service as unknown as PrivateBankConnectionsService).processWebhook(
      'event-id',
    );

    expect(prisma.bankConnection.upsert).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.update).toHaveBeenLastCalledWith({
      where: { externalId: 'event-id' },
      data: {
        status: WebhookEventStatus.PROCESSED,
        processedAt: expect.any(Date) as Date,
        lastError: null,
      },
    });
  });

  it('does not move an account already imported by another user', async () => {
    prisma.bankConnection.upsert.mockResolvedValue({ id: 'new-connection' });
    prisma.bankAccount.findFirst.mockResolvedValue({
      id: 'existing-account',
      userId: 'other-user',
      bankConnectionId: 'existing-connection',
    });
    prisma.bankConnection.update.mockResolvedValue({});
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ apiKey: 'api-key' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'item-id',
            clientUserId: attemptId,
            connector: { id: 200, name: 'MeuPluggy' },
            status: 'UPDATED',
            executionStatus: 'SUCCESS',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ id: 'account-id', name: 'Conta Corrente' }],
          }),
          { status: 200 },
        ),
      );

    await expect(
      (service as unknown as PrivateBankConnectionsService).syncItem(
        'user-id',
        'item-id',
        attemptId,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.bankAccount.upsert).not.toHaveBeenCalled();
    expect(prisma.bankConnection.update).toHaveBeenCalledWith({
      where: { id: 'new-connection' },
      data: {
        status: BankConnectionStatus.ERROR,
        errorCode: 'DUPLICATE_BANK_ACCOUNT',
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
