import { Prisma, TransactionType } from '@prisma/client';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { TransactionsService } from './transactions.service';

describe('TransactionsService', () => {
  const prisma = {
    transaction: {
      findMany: jest.fn(),
      groupBy: jest.fn(),
    },
  };

  const row = (id: string) => ({
    id,
    userId: 'user-id',
    categoryId: null,
    bankAccountId: null,
    type: TransactionType.EXPENSE,
    source: 'MANUAL',
    nature: 'VARIABLE',
    status: 'POSTED',
    title: id,
    description: null,
    amount: new Prisma.Decimal(10),
    transactionDate: new Date('2026-07-15T12:00:00.000Z'),
    externalId: null,
    providerCategoryId: null,
    providerCategoryName: null,
    excludedFromBudget: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    category: null,
    bankAccount: null,
  });

  beforeEach(() => jest.clearAllMocks());

  it('returns a bounded cursor page without duplicating the lookahead row', async () => {
    prisma.transaction.findMany.mockResolvedValue(
      Array.from({ length: 31 }, (_, index) => row(`transaction-${index + 1}`)),
    );
    prisma.transaction.groupBy.mockResolvedValue([
      {
        type: TransactionType.EXPENSE,
        _sum: { amount: new Prisma.Decimal(310) },
      },
    ]);
    const service = new TransactionsService(prisma as unknown as PrismaService);

    const result = await service.list('user-id', { pageSize: 30 });

    expect(result.items).toHaveLength(30);
    expect(result.nextCursor).toBe('transaction-30');
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 31 }),
    );
  });

  it('applies the supplied cursor and returns a final page', async () => {
    prisma.transaction.findMany.mockResolvedValue([row('transaction-31')]);
    prisma.transaction.groupBy.mockResolvedValue([]);
    const service = new TransactionsService(prisma as unknown as PrismaService);

    const result = await service.list('user-id', {
      pageSize: 30,
      cursor: '2b5d43c2-b170-46ef-b0e2-8fd63ce18da8',
    });

    expect(result.nextCursor).toBeNull();
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: '2b5d43c2-b170-46ef-b0e2-8fd63ce18da8' },
        skip: 1,
      }),
    );
  });
});
