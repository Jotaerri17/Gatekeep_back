import { calculateBudgetSummary } from './dashboard-calculations';

describe('calculateBudgetSummary', () => {
  it('returns healthy while committed spending is below 80% of the limit', () => {
    const summary = calculateBudgetSummary({
      limit: 3000,
      realized: 500,
      pending: 100,
      income: 2000,
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
    });

    expect(summary.status).toBe('EXCEEDED');
    expect(summary.available).toBe(-1);
  });

  it('returns not configured without a monthly limit', () => {
    expect(
      calculateBudgetSummary({
        limit: null,
        realized: 100,
        pending: 0,
        income: 0,
      }).status,
    ).toBe('NOT_CONFIGURED');
  });
});
