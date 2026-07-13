import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TransactionSource,
  TransactionStatus,
  TransactionType,
} from '@prisma/client';
import { money, parseMoney } from '../finance/finance.utils';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { ListTransactionsDto } from './dto/list-transactions.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';

const transactionInclude = {
  category: true,
  bankAccount: { include: { bankConnection: true } },
} satisfies Prisma.TransactionInclude;

@Injectable()
export class TransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, query: ListTransactionsDto) {
    const where: Prisma.TransactionWhereInput = {
      userId,
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search.trim(), mode: 'insensitive' } },
              {
                description: {
                  contains: query.search.trim(),
                  mode: 'insensitive',
                },
              },
            ],
          }
        : {}),
      ...(query.from || query.to
        ? {
            transactionDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.nature ? { nature: query.nature } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.excluded
        ? { excludedFromBudget: query.excluded === 'true' }
        : {}),
    };
    const rows = await this.prisma.transaction.findMany({
      where,
      include: transactionInclude,
      orderBy: [{ transactionDate: 'desc' }, { id: 'desc' }],
      take: query.pageSize + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.pageSize;
    const items = hasMore ? rows.slice(0, query.pageSize) : rows;

    const totals = await this.prisma.transaction.groupBy({
      by: ['type'],
      where,
      _sum: { amount: true },
    });

    return {
      items: items.map((item) => this.serialize(item)),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      totals: {
        expenses: money(
          totals.find((row) => row.type === TransactionType.EXPENSE)?._sum
            .amount ?? 0,
        ),
        income: money(
          totals.find((row) => row.type === TransactionType.INCOME)?._sum
            .amount ?? 0,
        ),
      },
    };
  }

  async create(userId: string, dto: CreateTransactionDto) {
    await this.assertCategory(userId, dto.categoryId, dto.type);
    if (dto.type === TransactionType.EXPENSE && !dto.nature) {
      throw new BadRequestException('Expense nature is required');
    }

    const transaction = await this.prisma.transaction.create({
      data: {
        userId,
        categoryId: dto.categoryId || null,
        type: dto.type,
        source: TransactionSource.MANUAL,
        nature: dto.type === TransactionType.EXPENSE ? dto.nature : null,
        status: TransactionStatus.POSTED,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        amount: parseMoney(dto.amount),
        transactionDate: new Date(dto.transactionDate),
      },
      include: transactionInclude,
    });
    return this.serialize(transaction);
  }

  async update(userId: string, id: string, dto: UpdateTransactionDto) {
    const existing = await this.findOwned(userId, id);
    const nextType = dto.type ?? existing.type;
    const nextNature = dto.nature ?? existing.nature;
    await this.assertCategory(userId, dto.categoryId, nextType);

    if (nextType === TransactionType.EXPENSE && !nextNature) {
      throw new BadRequestException('Expense nature is required');
    }

    if (
      existing.source === TransactionSource.PLUGGY &&
      [
        dto.type,
        dto.title,
        dto.description,
        dto.amount,
        dto.transactionDate,
      ].some((value) => value !== undefined)
    ) {
      throw new BadRequestException(
        'Imported transactions only allow category, nature or budget inclusion changes',
      );
    }

    const transaction = await this.prisma.transaction.update({
      where: { id },
      data: {
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.nature !== undefined ? { nature: dto.nature } : {}),
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description?.trim() || null }
          : {}),
        ...(dto.amount !== undefined ? { amount: parseMoney(dto.amount) } : {}),
        ...(dto.transactionDate !== undefined
          ? { transactionDate: new Date(dto.transactionDate) }
          : {}),
        ...(dto.categoryId !== undefined
          ? { categoryId: dto.categoryId || null }
          : {}),
        ...(dto.excludedFromBudget !== undefined
          ? { excludedFromBudget: dto.excludedFromBudget }
          : {}),
        ...(nextType === TransactionType.INCOME ? { nature: null } : {}),
      },
      include: transactionInclude,
    });
    return this.serialize(transaction);
  }

  async remove(userId: string, id: string) {
    const existing = await this.findOwned(userId, id);
    if (existing.source !== TransactionSource.MANUAL) {
      throw new BadRequestException('Imported transactions cannot be deleted');
    }
    await this.prisma.transaction.delete({ where: { id } });
    return { deleted: true };
  }

  private async findOwned(userId: string, id: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id, userId },
    });
    if (!transaction) throw new NotFoundException('Transaction not found');
    return transaction;
  }

  private async assertCategory(
    userId: string,
    categoryId: string | null | undefined,
    type: TransactionType,
  ) {
    if (categoryId === undefined || categoryId === null || categoryId === '')
      return;
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, userId, type, isActive: true },
    });
    if (!category)
      throw new BadRequestException('Category is invalid for this transaction');
  }

  private serialize(
    transaction: Prisma.TransactionGetPayload<{
      include: typeof transactionInclude;
    }>,
  ) {
    return {
      ...transaction,
      amount: money(transaction.amount),
      institution:
        transaction.bankAccount?.bankConnection.institutionName ?? null,
      accountName: transaction.bankAccount?.name ?? null,
    };
  }
}
