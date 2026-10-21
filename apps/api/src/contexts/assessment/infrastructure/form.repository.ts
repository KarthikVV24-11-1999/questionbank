import type { Pool, PoolClient } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { exposureEntriesOf } from '../domain/exposure.js';
import { closeForm, openForm, publishForm, restoreForm, scheduleForm, type Form, type FormError, type FormSlot, type FormState, type ScheduleWindow } from '../domain/form.js';
import type { FormRepository, RepositoryError } from '../domain/repository-ports.js';
import { conflict, fromDatabaseError, notFound, persistenceRejected } from './repository-errors.js';

interface FormRow {
  readonly form_id: string;
  readonly exam_profile_version_id: string;
  readonly form_type: 'mock' | 'diagnostic';
  readonly session_ref: string;
  readonly state: FormState;
  readonly blueprint_conformance: Record<string, unknown>;
  readonly published_at: Date | null;
  readonly opens_at: Date | null;
  readonly closes_at: Date | null;
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

      if (stored !== undefined && stored.state !== 'draft') {
        const current = await this.#read(client, form.formId);
        await client.query('ROLLBACK');
        if (!current.ok) return current;
        return fingerprint(current.value) === fingerprint(form)
          ? ok(current.value)
          : err(conflict('the form is published and immutable (D-006)', 'formId'));
      }

      // Publication writes the ledger and checks the pool, and only `publish` does either.
      if (form.state !== 'draft') {
        await client.query('ROLLBACK');
        return err(persistenceRejected('a form is published with publish(), which writes its exposure ledger in the same transaction', 'state'));
      }

      if (stored === undefined) {
        await client.query(
          `INSERT INTO assessment.form (form_id, exam_profile_version_id, form_type, session_ref, blueprint_conformance)
           VALUES ($1, $2, $3, $4, $5)`,
          [form.formId, form.examProfileVersionId, form.formType, form.sessionRef, JSON.stringify(form.blueprintConformance)],
        );
      } else {
        await client.query(
          `UPDATE assessment.form SET exam_profile_version_id = $2, form_type = $3, session_ref = $4, blueprint_conformance = $5 WHERE form_id = $1`,
          [form.formId, form.examProfileVersionId, form.formType, form.sessionRef, JSON.stringify(form.blueprintConformance)],
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

      await client.query('COMMIT');
      return ok(form);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return err(fromDatabaseError(error));
    }
  }

  /**
   * The publication transaction. The form row is locked first, so a save or a
   * second publish racing this one waits and then finds the form published.
   * Inside it, in order: the pool is read, the domain decides (flags agree with
   * the pool, the anchor floor holds), the ledger is written, the state moves.
   * A refusal at any step rolls everything back, so a form is never left
   * published without its exposure counted or counted without being published.
   */
  async publish(formId: string, now: string): Promise<Result<Form, RepositoryError | FormError>> {
    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      return err(fromDatabaseError(error));
    }
    // `#publish` returns a value whatever happens (it catches), so the connection is released on every path.
    const outcome = await this.#publish(client, formId, now);
    client.release();
    return outcome;
  }

  async #publish(client: PoolClient, formId: string, now: string): Promise<Result<Form, RepositoryError | FormError>> {
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT 1 FROM assessment.form WHERE form_id = $1 FOR UPDATE', [formId]);
      if (locked.rows.length === 0) {
        await client.query('ROLLBACK');
        return err(notFound('form', formId));
      }
      const stored = await this.#read(client, formId);
      if (!stored.ok) {
        await client.query('ROLLBACK');
        return stored;
      }
      // Already published: nothing to write, and in particular no second set of ledger rows.
      if (stored.value.state === 'published') {
        await client.query('ROLLBACK');
        return stored;
      }

      const members = await client.query<{ item_version_id: string }>(
        'SELECT item_version_id FROM assessment.anchor_pool_member WHERE retired_at IS NULL',
      );
      const published = publishForm(stored.value, now, new Set(members.rows.map((row) => row.item_version_id)));
      if (!published.ok) {
        await client.query('ROLLBACK');
        return err(published.error);
      }
      // A published form always has entries, so this cannot be refused.
      const entries = exposureEntriesOf(published.value) as Extract<ReturnType<typeof exposureEntriesOf>, { ok: true }>;
      for (const entry of entries.value) {
        await client.query(
          `INSERT INTO assessment.exposure_ledger_entry (form_id, slot_id, item_id, item_version_id, session_ref, is_anchor, written_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [entry.formId, entry.slotId, entry.itemId, entry.itemVersionId, entry.sessionRef, entry.isAnchor, entry.writtenAt],
        );
      }
      await client.query(`UPDATE assessment.form SET state = 'published', published_at = $2 WHERE form_id = $1`, [formId, now]);
      await client.query('COMMIT');
      return ok(published.value);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return err(fromDatabaseError(error));
    }
  }

  /** Gives a published form its window and seals it until the window opens. */
  schedule(formId: string, window: ScheduleWindow, now: string): Promise<Result<Form, RepositoryError | FormError>> {
    return this.#advance(formId, (form) => scheduleForm(form, window, now));
  }

  /** Opens a scheduled form whose window has begun. */
  open(formId: string, now: string): Promise<Result<Form, RepositoryError | FormError>> {
    return this.#advance(formId, (form) => openForm(form, now));
  }

  /** Closes an open form whose window has ended. */
  close(formId: string, now: string): Promise<Result<Form, RepositoryError | FormError>> {
    return this.#advance(formId, (form) => closeForm(form, now));
  }

  /**
   * One move along the lifecycle, decided by the domain and applied under the
   * form's row lock, so two operators acting on the same form cannot both move
   * it from the state they each read. Only the state and the window are
   * written: the composition is frozen, and the database holds that too.
   */
  async #advance(formId: string, decide: (form: Form) => Result<Form, FormError>): Promise<Result<Form, RepositoryError | FormError>> {
    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      return err(fromDatabaseError(error));
    }
    // `#move` returns a value whatever happens (it catches), so the connection is released on every path.
    const outcome = await this.#move(client, formId, decide);
    client.release();
    return outcome;
  }

  async #move(client: PoolClient, formId: string, decide: (form: Form) => Result<Form, FormError>): Promise<Result<Form, RepositoryError | FormError>> {
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT 1 FROM assessment.form WHERE form_id = $1 FOR UPDATE', [formId]);
      if (locked.rows.length === 0) {
        await client.query('ROLLBACK');
        return err(notFound('form', formId));
      }
      const stored = await this.#read(client, formId);
      if (!stored.ok) {
        await client.query('ROLLBACK');
        return stored;
      }
      const moved = decide(stored.value);
      if (!moved.ok) {
        await client.query('ROLLBACK');
        return moved;
      }
      await client.query('UPDATE assessment.form SET state = $2, opens_at = $3, closes_at = $4 WHERE form_id = $1', [
        formId,
        moved.value.state,
        // Every move past publication carries the window, so there is no null to write.
        (moved.value.scheduleWindow as ScheduleWindow).opensAt,
        (moved.value.scheduleWindow as ScheduleWindow).closesAt,
      ]);
      await client.query('COMMIT');
      return ok(moved.value);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return err(fromDatabaseError(error));
    }
  }

  /** Scheduled forms whose window has begun — what a sweep would open. Oldest window first. */
  findDueToOpen(now: string, limit: number): Promise<Result<readonly Form[], RepositoryError>> {
    return this.#due(`state = 'embargoed' AND opens_at <= $1`, now, limit);
  }

  /** Open forms whose window has ended — what a sweep would close. Oldest window first. */
  findDueToClose(now: string, limit: number): Promise<Result<readonly Form[], RepositoryError>> {
    return this.#due(`state = 'active' AND closes_at <= $1`, now, limit);
  }

  async #due(condition: string, now: string, limit: number): Promise<Result<readonly Form[], RepositoryError>> {
    try {
      const client = await this.#pool.connect();
      try {
        const ids = await client.query<{ form_id: string }>(
          `SELECT form_id FROM assessment.form WHERE ${condition} ORDER BY closes_at, form_id LIMIT $2`,
          [now, limit],
        );
        const forms: Form[] = [];
        for (const row of ids.rows) {
          const form = await this.#read(client, row.form_id);
          if (!form.ok) return form;
          forms.push(form.value);
        }
        return ok(Object.freeze(forms));
      } finally {
        client.release();
      }
    } catch (error) {
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
      `SELECT form_id, exam_profile_version_id, form_type, session_ref, state, blueprint_conformance, published_at, opens_at, closes_at
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
      sessionRef: row.session_ref,
      blueprintConformance: row.blueprint_conformance,
      state: row.state,
      publishedAt: row.published_at === null ? null : row.published_at.toISOString(),
      scheduleWindow:
        row.opens_at === null || row.closes_at === null
          ? null
          : { opensAt: row.opens_at.toISOString(), closesAt: row.closes_at.toISOString() },
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

