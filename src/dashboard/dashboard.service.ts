import { Injectable } from '@nestjs/common';
import { Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import { BudgetsService } from '../budgets/budgets.service';
import {
  BRAZIL_TIMEZONE,
  getMonthRange,
  money,
  parseReferenceMonth,
  zonedDateTimeToUtc,
} from '../finance/finance.utils';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { calculateBudgetSummary } from './dashboard-calculations';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

type TimelineTransaction = {
  transactionDate: Date;
  type: TransactionType;
  amount: Prisma.Decimal;
  excludedFromBudget: boolean;
};

export function buildDashboardTimeline(
  transactions: TimelineTransaction[],
  period: DashboardQueryDto['period'],
  range: { start: Date; end: Date },
  timezone = BRAZIL_TIMEZONE,
) {
  const totals = new Map<string, Prisma.Decimal>();
  const labels = new Map<string, string>();
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const hourFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  });

  if (period === 'day') {
    for (let hour = 0; hour < 24; hour += 1) {
      const key = String(hour).padStart(2, '0');
      labels.set(key, `${key}h`);
      totals.set(key, new Prisma.Decimal(0));
    }
  } else {
    const labelFormatter = new Intl.DateTimeFormat('pt-BR', {
      timeZone: timezone,
      ...(period === 'week' ? { weekday: 'short' } : { day: '2-digit' }),
    });
    const cursor = new Date(range.start);
    while (cursor < range.end) {
      const key = dateFormatter.format(cursor);
      labels.set(key, labelFormatter.format(cursor));
      totals.set(key, new Prisma.Decimal(0));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  for (const item of transactions) {
    if (item.type !== TransactionType.EXPENSE || item.excludedFromBudget)
      continue;
    const key =
      period === 'day'
        ? (hourFormatter
            .formatToParts(item.transactionDate)
            .find((part) => part.type === 'hour')?.value ?? '')
        : dateFormatter.format(item.transactionDate);
    if (!totals.has(key)) continue;
    totals.set(key, totals.get(key)!.add(item.amount));
  }

  return [...labels.entries()].map(([key, label]) => ({
    key,
    label,
    total: money(totals.get(key) ?? 0),
  }));
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly budgetsService: BudgetsService,
  ) {}

  async get(userId: string, query: DashboardQueryDto) {
    await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const { referenceMonth, year, month } = parseReferenceMonth(query.month);
    const { start, end } = getMonthRange(referenceMonth, BRAZIL_TIMEZONE);
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
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const currentDay = Number(
      now.toLocaleDateString('en-US', {
        timeZone: BRAZIL_TIMEZONE,
        day: 'numeric',
      }),
    );
    const summary = calculateBudgetSummary({
      limit: budget.totalLimit === null ? null : Number(budget.totalLimit),
      realized: realized.toNumber(),
      pending: pending.toNumber(),
      income: income.toNumber(),
    });
    const periodRange = this.getPeriodRange(
      query.period,
      query.anchor ??
        `${referenceMonth}-${String(Math.min(currentDay, daysInMonth)).padStart(2, '0')}`,
      referenceMonth,
      BRAZIL_TIMEZONE,
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
      },
      timeline: buildDashboardTimeline(
        periodTransactions,
        query.period,
        periodRange,
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
}
