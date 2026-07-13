import { Injectable } from '@nestjs/common';
import { Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import { BudgetsService } from '../budgets/budgets.service';
import {
  getMonthRange,
  money,
  parseReferenceMonth,
  zonedDateTimeToUtc,
} from '../finance/finance.utils';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { calculateBudgetSummary } from './dashboard-calculations';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly budgetsService: BudgetsService,
  ) {}

  async get(userId: string, query: DashboardQueryDto) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const { referenceMonth, year, month } = parseReferenceMonth(query.month);
    const { start, end } = getMonthRange(referenceMonth, user.timezone);
    const [budget, transactions, connections] = await Promise.all([
      this.budgetsService.get(userId, referenceMonth),
      this.prisma.transaction.findMany({
        where: { userId, transactionDate: { gte: start, lt: end } },
        include: { category: true },
        orderBy: [{ transactionDate: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.bankConnection.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    const includedExpenses = transactions.filter(
      (item) =>
        item.type === TransactionType.EXPENSE && !item.excludedFromBudget,
    );
    const realized = this.sum(
      includedExpenses.filter(
        (item) => item.status === TransactionStatus.POSTED,
      ),
    );
    const pending = this.sum(
      includedExpenses.filter(
        (item) => item.status === TransactionStatus.PENDING,
      ),
    );
    const income = this.sum(
      transactions.filter(
        (item) =>
          item.type === TransactionType.INCOME && !item.excludedFromBudget,
      ),
    );
    const now = new Date();
    const currentMonth = now.toLocaleDateString('en-CA', {
      timeZone: user.timezone,
      year: 'numeric',
      month: '2-digit',
    });
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const currentDay = Number(
      now.toLocaleDateString('en-US', {
        timeZone: user.timezone,
        day: 'numeric',
      }),
    );
    const isCurrentMonth = referenceMonth === currentMonth;
    const elapsedDays = isCurrentMonth ? currentDay : daysInMonth;
    const remainingDays = isCurrentMonth ? daysInMonth - currentDay + 1 : 1;
    const summary = calculateBudgetSummary({
      limit: budget.totalLimit === null ? null : Number(budget.totalLimit),
      realized: realized.toNumber(),
      pending: pending.toNumber(),
      income: income.toNumber(),
      elapsedDays,
      daysInMonth,
      remainingDays,
      isCurrentMonth,
    });
    const periodRange = this.getPeriodRange(
      query.period,
      query.anchor ??
        `${referenceMonth}-${String(Math.min(currentDay, daysInMonth)).padStart(2, '0')}`,
      referenceMonth,
      user.timezone,
    );
    const periodTransactions = transactions.filter(
      (item) =>
        item.transactionDate >= periodRange.start &&
        item.transactionDate < periodRange.end,
    );
    const categoryTotals = new Map<
      string,
      { name: string; color: string | null; total: Prisma.Decimal }
    >();
    for (const transaction of periodTransactions) {
      if (
        transaction.type !== TransactionType.EXPENSE ||
        transaction.excludedFromBudget
      )
        continue;
      const id = transaction.categoryId ?? 'uncategorized';
      const current = categoryTotals.get(id);
      categoryTotals.set(id, {
        name: transaction.category?.name ?? 'Sem categoria',
        color: transaction.category?.color ?? null,
        total: (current?.total ?? new Prisma.Decimal(0)).add(
          transaction.amount,
        ),
      });
    }

    return {
      referenceMonth,
      period: query.period,
      budget: {
        ...summary,
        limit: budget.totalLimit,
        realized: summary.realized.toFixed(2),
        pending: summary.pending.toFixed(2),
        committed: summary.committed.toFixed(2),
        income: summary.income.toFixed(2),
        available: summary.available?.toFixed(2) ?? null,
        projection: summary.projection.toFixed(2),
        dailySuggestion: summary.dailySuggestion?.toFixed(2) ?? null,
      },
      timeline: this.buildTimeline(
        periodTransactions,
        query.period,
        user.timezone,
      ),
      categories: [...categoryTotals.entries()]
        .map(([id, item]) => ({
          id,
          name: item.name,
          color: item.color,
          total: money(item.total),
        }))
        .sort((a, b) => Number(b.total) - Number(a.total)),
      recentTransactions: transactions.slice(0, 5).map((item) => ({
        id: item.id,
        title: item.title,
        amount: money(item.amount),
        type: item.type,
        status: item.status,
        source: item.source,
        transactionDate: item.transactionDate,
        category: item.category?.name ?? null,
      })),
      uncategorizedCount: transactions.filter(
        (item) => item.type === TransactionType.EXPENSE && !item.categoryId,
      ).length,
      connections: {
        count: connections.filter((item) => item.status !== 'DISCONNECTED')
          .length,
        latestStatus: connections[0]?.status ?? null,
        lastSyncedAt:
          connections.find((item) => item.lastSyncedAt)?.lastSyncedAt ?? null,
      },
      onboarding: {
        hasBudget: budget.totalLimit !== null,
        hasTransactions: transactions.length > 0,
        hasBankConnection: connections.some(
          (item) => item.status !== 'DISCONNECTED',
        ),
      },
    };
  }

  private sum(items: { amount: Prisma.Decimal }[]) {
    return items.reduce(
      (sum, item) => sum.add(item.amount),
      new Prisma.Decimal(0),
    );
  }

  private getPeriodRange(
    period: DashboardQueryDto['period'],
    anchor: string,
    referenceMonth: string,
    timezone: string,
  ) {
    if (period === 'month') return getMonthRange(referenceMonth, timezone);
    const [year, month, day] = anchor.split('-').map(Number);
    let startDay = day;
    if (period === 'week') {
      const weekDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      startDay -= weekDay === 0 ? 6 : weekDay - 1;
    }
    const startUtc = new Date(Date.UTC(year, month - 1, startDay));
    const endUtc = new Date(startUtc);
    endUtc.setUTCDate(endUtc.getUTCDate() + (period === 'week' ? 7 : 1));
    return {
      start: zonedDateTimeToUtc(
        startUtc.getUTCFullYear(),
        startUtc.getUTCMonth() + 1,
        startUtc.getUTCDate(),
        timezone,
      ),
      end: zonedDateTimeToUtc(
        endUtc.getUTCFullYear(),
        endUtc.getUTCMonth() + 1,
        endUtc.getUTCDate(),
        timezone,
      ),
    };
  }

  private buildTimeline(
    transactions: {
      transactionDate: Date;
      type: TransactionType;
      amount: Prisma.Decimal;
      excludedFromBudget: boolean;
    }[],
    period: DashboardQueryDto['period'],
    timezone: string,
  ) {
    const totals = new Map<string, Prisma.Decimal>();
    const formatter = new Intl.DateTimeFormat('pt-BR', {
      timeZone: timezone,
      ...(period === 'day'
        ? { hour: '2-digit' }
        : period === 'week'
          ? { weekday: 'short' }
          : { day: '2-digit' }),
    });
    for (const item of transactions) {
      if (item.type !== TransactionType.EXPENSE || item.excludedFromBudget)
        continue;
      const key = formatter.format(item.transactionDate);
      totals.set(
        key,
        (totals.get(key) ?? new Prisma.Decimal(0)).add(item.amount),
      );
    }
    return [...totals.entries()].map(([label, total]) => ({
      label,
      total: money(total),
    }));
  }
}
