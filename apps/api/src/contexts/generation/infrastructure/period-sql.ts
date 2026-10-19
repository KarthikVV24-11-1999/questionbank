/**
 * The SQL for "this timestamp column falls in UTC month `$n`", written once.
 *
 * The run repository sums reservations over it and the ledger sums spend over it,
 * so which month a row belongs to is one expression and not two that agree today.
 * The month's *name* is computed in TypeScript (`periodOf`); the specs hold the two
 * to the same answer at the boundaries, because a rule in two languages drifts.
 */
export function inPeriod(column: string, parameter: number): string {
  const start = `(($${parameter} || '-01')::date)::timestamp AT TIME ZONE 'UTC'`;
  const next = `((($${parameter} || '-01')::date + interval '1 month'))::timestamp AT TIME ZONE 'UTC'`;
  return `${column} >= ${start} AND ${column} < ${next}`;
}
