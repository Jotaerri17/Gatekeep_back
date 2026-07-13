import { calculateBudgetSummary } from './dashboard-calculations';

describe('calculateBudgetSummary', () => {
  it('returns healthy when the projection is below the configured limit', () => {
    const summary = calculateBudgetSummary({
      limit: 3000,
      realized: 500,
      pending: 100,
      income: 2000,
      elapsedDays: 15,
      daysInMonth: 30,
      remainingDays: 16,
      isCurrentMonth: true,
    });

    expect(summary.status).toBe('HEALTHY');
    expect(summary.available).toBe(2400);
  });

  it('uses pending expenses and ignores income when calculating available money', () => {
    const summary = calculateBudgetSummary({
      limit: 1000,
      realized: 600,
      pending: 250,
      income: 5000,
      elapsedDays: 20,
      daysInMonth: 30,
      remainingDays: 11,
      isCurrentMonth: true,
    });

    expect(summary.committed).toBe(850);
    expect(summary.available).toBe(150);
    expect(summary.status).toBe('ATTENTION');
  });

  it('returns exceeded only when committed expenses are above the limit', () => {
    const summary = calculateBudgetSummary({
      limit: 1000,
      realized: 1001,
      pending: 0,
      income: 0,
      elapsedDays: 30,
      daysInMonth: 30,
      remainingDays: 1,
      isCurrentMonth: true,
    });

    expect(summary.status).toBe('EXCEEDED');
    expect(summary.available).toBe(-1);
    expect(summary.dailySuggestion).toBe(0);
  });

  it('returns not configured without a monthly limit', () => {
    expect(
      calculateBudgetSummary({
        limit: null,
        realized: 100,
        pending: 0,
        income: 0,
        elapsedDays: 10,
        daysInMonth: 30,
        remainingDays: 21,
        isCurrentMonth: true,
      }).status,
    ).toBe('NOT_CONFIGURED');
  });
});
