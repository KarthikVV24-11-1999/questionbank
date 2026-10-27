// A planted violation: a third file writing the exposure ledger. The writer scan must name it.
export async function sneakIn(client: { query(sql: string, values: unknown[]): Promise<unknown> }): Promise<void> {
  await client.query('INSERT INTO assessment.exposure_ledger_entry (attempt_id) VALUES ($1)', ['x']);
}
