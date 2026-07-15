import { Prisma, TransactionType } from '@prisma/client';
import { buildDashboardTimeline } from './dashboard.service';

describe('buildDashboardTimeline', () => {
  const transaction = (date: string, amount: string) => ({
    transactionDate: new Date(date),
    type: TransactionType.EXPENSE,
    amount: new Prisma.Decimal(amount),
    excludedFromBudget: false,
  });

  it('returns every hour in chronological order and fills empty hours', () => {
    const timeline = buildDashboardTimeline(
      [transaction('2026-07-15T15:30:00.000Z', '42.50')],
      'day',
      {
        start: new Date('2026-07-15T03:00:00.000Z'),
        end: new Date('2026-07-16T03:00:00.000Z'),
      },
    );

    expect(timeline).toHaveLength(24);
    expect(timeline[0]).toEqual({ key: '00', label: '00h', total: '0.00' });
    expect(timeline[12]).toEqual({ key: '12', label: '12h', total: '42.50' });
  });

  it('returns all days in a week and sums expenses by local date', () => {
    const timeline = buildDashboardTimeline(
      [
        transaction('2026-07-13T13:00:00.000Z', '10'),
        transaction('2026-07-13T20:00:00.000Z', '15'),
      ],
      'week',
      {
        start: new Date('2026-07-13T03:00:00.000Z'),
        end: new Date('2026-07-20T03:00:00.000Z'),
      },
    );

    expect(timeline).toHaveLength(7);
    expect(timeline[0]).toMatchObject({ key: '2026-07-13', total: '25.00' });
    expect(timeline[6]).toMatchObject({ key: '2026-07-19', total: '0.00' });
  });
});
