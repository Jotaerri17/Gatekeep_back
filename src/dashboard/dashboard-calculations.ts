export type BudgetStatus =
  | 'NOT_CONFIGURED'
  | 'HEALTHY'
  | 'ATTENTION'
  | 'EXCEEDED';

export function calculateBudgetSummary(input: {
  limit: number | null;
  realized: number;
  pending: number;
  income: number;
}) {
  const committed = input.realized + input.pending;
  const available = input.limit === null ? null : input.limit - committed;
  let status: BudgetStatus = 'NOT_CONFIGURED';

  if (input.limit !== null) {
    if (available !== null && available < 0) {
      status = 'EXCEEDED';
    } else if (committed >= input.limit * 0.8) {
      status = 'ATTENTION';
    } else {
      status = 'HEALTHY';
    }
  }

  return {
    status,
    realized: input.realized,
    pending: input.pending,
    committed,
    income: input.income,
    available,
    progress:
      input.limit && input.limit > 0
        ? Math.min(999, Math.round((committed / input.limit) * 100))
        : null,
  };
}
