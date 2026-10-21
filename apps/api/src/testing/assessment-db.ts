import type { Pool } from 'pg';
import { MARKING_HASH, TAG, formSlots, id } from './assessment-fixtures.js';

/**
 * Raw SQL helpers for specs that attack the assessment schema directly. They
 * bypass the repositories on purpose: a spec of the database's own refusals
 * must not depend on the code that is supposed to stay inside them.
 */

export interface SeedOptions {
  readonly formId?: string;
  readonly attemptId?: string;
  readonly studentId?: string;
  readonly mode?: 'mock' | 'diagnostic';
  readonly publish?: boolean;
  /** Shifts the slot ids so a second form can coexist with the first. */
  readonly variant?: number;
}

export const NOW_ISO = '2026-10-21T09:00:00.000Z';

/** A form of six slots in two sections, published unless told otherwise. */
export async function seedForm(pool: Pool, options: SeedOptions = {}): Promise<string> {
  const formId = options.formId ?? id(TAG.form);
  const mode = options.mode ?? 'mock';
  await pool.query(
    `INSERT INTO assessment.form (form_id, exam_profile_version_id, form_type, blueprint_conformance)
     VALUES ($1, $2, $3, '{"satisfied": true}')`,
    [formId, id(TAG.profile), mode],
  );
  await pool.query(`INSERT INTO assessment.form_section (form_id, ordinal, section_spec_ref) VALUES ($1, 1, 'a'), ($1, 2, 'b')`, [formId]);
  for (const [i, slot] of formSlots().entries()) {
    await pool.query(
      `INSERT INTO assessment.form_slot (slot_id, form_id, section_ordinal, ordinal, item_id, item_version_id, stimulus_version_id, marks_available, is_anchor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 4, $8)`,
      [id(TAG.slot, i + 1 + 100 * (options.variant ?? 0)), formId, i < 3 ? 1 : 2, slot.ordinal, slot.itemId, slot.itemVersionId, slot.stimulusVersionId, slot.isAnchor],
    );
  }
  if (options.publish !== false) {
    await pool.query(`UPDATE assessment.form SET state = 'published', published_at = $2 WHERE form_id = $1`, [formId, NOW_ISO]);
  }
  return formId;
}

/** An attempt in `created`, with its slots pinned from the seeded form. */
export async function seedAttempt(pool: Pool, options: SeedOptions = {}): Promise<string> {
  const attemptId = options.attemptId ?? id(TAG.attempt);
  const formId = options.formId ?? id(TAG.form);
  await pool.query(
    `INSERT INTO assessment.attempt
       (attempt_id, student_id, mode, form_id, exam_profile_version_id, marking_rule_set_hash, taxonomy_version_id,
        delivery_policy, session_id, shift_id, duration_ms, window_closes_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '{"timing": "strict"}', $8, 'shift-1', 10800000, '2026-10-21T12:00:00Z', '2026-10-21T08:00:00Z')`,
    [attemptId, options.studentId ?? id(TAG.student), options.mode ?? 'mock', formId, id(TAG.profile), MARKING_HASH, id(TAG.taxonomy), id(TAG.session)],
  );
  for (const slot of formSlots()) {
    await pool.query(
      `INSERT INTO assessment.attempt_slot (attempt_id, slot_id, ordinal, item_id, item_version_id, stimulus_version_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [attemptId, slot.slotId, slot.ordinal, slot.itemId, slot.itemVersionId, slot.stimulusVersionId],
    );
  }
  return attemptId;
}

export async function startAttemptRow(pool: Pool, attemptId: string): Promise<void> {
  await pool.query(
    `UPDATE assessment.attempt SET state = 'in_progress', started_at = '2026-10-21T09:00:00Z', deadline_at = '2026-10-21T12:00:00Z'
      WHERE attempt_id = $1`,
    [attemptId],
  );
}

export async function submitAttemptRow(pool: Pool, attemptId: string, key = 'k1'): Promise<void> {
  await pool.query(
    `UPDATE assessment.attempt SET state = 'submitted', submitted_at = '2026-10-21T10:00:00Z',
            submission_reason = 'manual', idempotency_key = $2 WHERE attempt_id = $1`,
    [attemptId, key],
  );
}

export async function insertEvent(
  pool: Pool,
  attemptId: string,
  n: number,
  overrides: Partial<{ slotId: string; itemVersionId: string; kind: string; answer: string | null }> = {},
): Promise<void> {
  const kind = overrides.kind ?? 'select';
  await pool.query(
    `INSERT INTO assessment.response_event
       (event_id, attempt_id, slot_id, item_version_id, sequence, kind, answer, client_monotonic_ms, server_received_at, device_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1000, '2026-10-21T09:05:00Z', 'phone-1')`,
    [
      id(TAG.event, n),
      attemptId,
      overrides.slotId ?? id(TAG.slot, 1),
      overrides.itemVersionId ?? id(TAG.itemVersion, 1),
      n,
      kind,
      overrides.answer === undefined ? (kind === 'select' || kind === 'change' ? '"A"' : null) : overrides.answer,
    ],
  );
}

/** The message the database refused with, or a failure if it did not refuse. */
export async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the database to refuse');
}

export const ASSESSMENT_TABLES = ['attempt', 'attempt_slot', 'form', 'form_section', 'form_slot', 'response_event'];
