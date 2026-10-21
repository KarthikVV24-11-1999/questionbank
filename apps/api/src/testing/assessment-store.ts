import type { Pool } from 'pg';
import { PostgresFormRepository } from '../contexts/assessment/infrastructure/form.repository.js';
import type { Form } from '../contexts/assessment/domain/form.js';
import type { CreateFormProps } from '../contexts/assessment/domain/form.js';
import { WINDOW, WITHIN_WINDOW, aDraftForm, poolOf } from './assessment-fixtures.js';
import { expectValue } from './expect-result.js';

export const PUBLISHED_AT = '2026-10-21T07:00:00.000Z';

/** Puts every item version a form flags as an anchor into the pool, as publication requires. */
export async function seedAnchorPool(pool: Pool, versions: ReadonlySet<string>): Promise<void> {
  for (const version of versions) {
    await pool.query(
      `INSERT INTO assessment.anchor_pool_member (item_version_id, exposure_cap, added_at) VALUES ($1, 40, '2026-10-01T00:00:00Z') ON CONFLICT DO NOTHING`,
      [version],
    );
  }
}

/** A form stored as a draft and then published through the one path that publishes, so its ledger rows exist. */
export async function storePublishedForm(pool: Pool, overrides: Partial<CreateFormProps> = {}): Promise<Form> {
  const forms = new PostgresFormRepository(pool);
  const draft = aDraftForm(overrides);
  expectValue(await forms.save(draft));
  await seedAnchorPool(pool, poolOf(draft));
  return expectValue(await forms.publish(draft.formId, PUBLISHED_AT));
}

/** A form published, scheduled for the fixture window and opened, so attempts may be created on it. */
export async function storeActiveForm(pool: Pool, overrides: Partial<CreateFormProps> = {}): Promise<Form> {
  const forms = new PostgresFormRepository(pool);
  const published = await storePublishedForm(pool, overrides);
  expectValue(await forms.schedule(published.formId, WINDOW, '2026-10-21T07:30:00.000Z'));
  return expectValue(await forms.open(published.formId, WITHIN_WINDOW));
}
