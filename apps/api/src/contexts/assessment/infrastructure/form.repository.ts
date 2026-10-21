import type { Pool, PoolClient } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { restoreForm, type Form, type FormSlot } from '../domain/form.js';
import type { FormRepository, RepositoryError } from '../domain/repository-ports.js';
import { conflict, fromDatabaseError, notFound, persistenceRejected } from './repository-errors.js';

interface FormRow {
  readonly form_id: string;
  readonly exam_profile_version_id: string;
  readonly form_type: 'mock' | 'diagnostic';
  readonly state: 'draft' | 'published';
  readonly blueprint_conformance: Record<string, unknown>;
  readonly published_at: Date | null;
}

interface SectionRow {
  readonly ordinal: number;
  readonly section_spec_ref: string;
}

interface SlotRow {
  readonly slot_id: string;
  readonly section_ordinal: number;
  readonly ordinal: number;
  readonly item_id: string;
  readonly item_version_id: string;
  readonly stimulus_version_id: string | null;
  readonly marks_available: number;
  readonly is_anchor: boolean;
}

/** Stable text for a form's content, so two forms can be compared without caring how their keys were ordered. */
function fingerprint(form: Form): string {
  return JSON.stringify(form, (_key, value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, (value as Record<string, unknown>)[key]]),
        )
      : value,
  );
}

/**
 * A draft is rewritten in one transaction under a row lock; a published form is
 * never written again. The row lock is what lets "is it published?" be decided
 * and acted on in one step: a publish racing a save cannot slip between the
 * read and the write.
 */
export class PostgresFormRepository implements FormRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async save(form: Form): Promise<Result<Form, RepositoryError>> {
    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      return err(fromDatabaseError(error));
    }
    // `#write` returns a value whatever happens (it catches), so the connection is released on every path.
    const outcome = await this.#write(client, form);
    client.release();
    return outcome;
  }

  async #write(client: PoolClient, form: Form): Promise<Result<Form, RepositoryError>> {
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ state: string }>('SELECT state FROM assessment.form WHERE form_id = $1 FOR UPDATE', [form.formId]);
      const stored = locked.rows[0];

      if (stored?.state === 'published') {
        const current = await this.#read(client, form.formId);
        await client.query('ROLLBACK');
        if (!current.ok) return current;
        return fingerprint(current.value) === fingerprint(form)
          ? ok(current.value)
          : err(conflict('the form is published and immutable (D-006)', 'formId'));
      }

      if (stored === undefined) {
        await client.query(
          `INSERT INTO assessment.form (form_id, exam_profile_version_id, form_type, blueprint_conformance)
           VALUES ($1, $2, $3, $4)`,
          [form.formId, form.examProfileVersionId, form.formType, JSON.stringify(form.blueprintConformance)],
        );
      } else {
        await client.query(
          `UPDATE assessment.form SET exam_profile_version_id = $2, form_type = $3, blueprint_conformance = $4 WHERE form_id = $1`,
          [form.formId, form.examProfileVersionId, form.formType, JSON.stringify(form.blueprintConformance)],
        );
        await client.query('DELETE FROM assessment.form_slot WHERE form_id = $1', [form.formId]);
        await client.query('DELETE FROM assessment.form_section WHERE form_id = $1', [form.formId]);
      }

      for (const section of form.sections) {
        await client.query('INSERT INTO assessment.form_section (form_id, ordinal, section_spec_ref) VALUES ($1, $2, $3)', [
          form.formId,
          section.ordinal,
          section.sectionSpecRef,
        ]);
        for (const slot of section.slots) {
          await client.query(
            `INSERT INTO assessment.form_slot
               (slot_id, form_id, section_ordinal, ordinal, item_id, item_version_id, stimulus_version_id, marks_available, is_anchor)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [slot.slotId, form.formId, section.ordinal, slot.ordinal, slot.itemId, slot.itemVersionId, slot.stimulusVersionId, slot.marksAvailable, slot.isAnchor],
          );
        }
      }

      if (form.state === 'published') {
        await client.query(`UPDATE assessment.form SET state = 'published', published_at = $2 WHERE form_id = $1`, [form.formId, form.publishedAt]);
      }
      await client.query('COMMIT');
      return ok(form);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return err(fromDatabaseError(error));
    }
  }

  async findById(formId: string): Promise<Result<Form, RepositoryError>> {
    try {
      const client = await this.#pool.connect();
      try {
        return await this.#read(client, formId);
      } finally {
        client.release();
      }
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async #read(client: PoolClient, formId: string): Promise<Result<Form, RepositoryError>> {
    const header = await client.query<FormRow>(
      `SELECT form_id, exam_profile_version_id, form_type, state, blueprint_conformance, published_at
         FROM assessment.form WHERE form_id = $1`,
      [formId],
    );
    const row = header.rows[0];
    if (row === undefined) return err(notFound('form', formId));

    const sections = await client.query<SectionRow>(
      'SELECT ordinal, section_spec_ref FROM assessment.form_section WHERE form_id = $1 ORDER BY ordinal',
      [formId],
    );
    const slots = await client.query<SlotRow>(
      `SELECT slot_id, section_ordinal, ordinal, item_id, item_version_id, stimulus_version_id, marks_available, is_anchor
         FROM assessment.form_slot WHERE form_id = $1 ORDER BY ordinal`,
      [formId],
    );

    const restored = restoreForm({
      formId: row.form_id,
      examProfileVersionId: row.exam_profile_version_id,
      formType: row.form_type,
      blueprintConformance: row.blueprint_conformance,
      state: row.state,
      publishedAt: row.published_at === null ? null : row.published_at.toISOString(),
      sections: sections.rows.map((section) => ({
        ordinal: section.ordinal,
        sectionSpecRef: section.section_spec_ref,
        slots: slots.rows
          .filter((slot) => slot.section_ordinal === section.ordinal)
          .map<FormSlot>((slot) => ({
            slotId: slot.slot_id,
            ordinal: slot.ordinal,
            itemId: slot.item_id,
            itemVersionId: slot.item_version_id,
            stimulusVersionId: slot.stimulus_version_id,
            marksAvailable: slot.marks_available,
            isAnchor: slot.is_anchor,
          })),
      })),
    });
    return restored.ok
      ? ok(restored.value)
      : err(persistenceRejected(`stored form ${formId} no longer satisfies the domain: ${restored.error.code}`, restored.error.location));
  }
}

