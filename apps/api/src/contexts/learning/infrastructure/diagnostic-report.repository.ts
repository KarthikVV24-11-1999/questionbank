import type { Pool } from 'pg';
import { applicationError, type ApplicationError } from '../application/authorization.js';
import type { DiagnosticReportStore, StoredReport } from '../application/ports.js';
import type { Finding } from '../domain/diagnostic-report.js';
import { err, ok, type Result } from '../domain/result.js';

const unavailable = (): ApplicationError => applicationError('Unavailable', 'REPORT_STORE_UNAVAILABLE', "the learner's reports could not be read or written");

/** Marks come back from `numeric` as text and are trimmed to the form the domain writes them in; no mark passes through a double. */
const trimmed = (value: string): string => (value.includes('.') ? value.replace(/\.?0+$/u, '') : value);

export class PostgresDiagnosticReportStore implements DiagnosticReportStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async insert(report: StoredReport): Promise<Result<boolean, ApplicationError>> {
    const client = await this.#pool.connect().catch(() => undefined);
    if (client === undefined) return err(unavailable());
    let outcome: Result<boolean, ApplicationError>;
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `INSERT INTO learning.diagnostic_report (report_id, learner_ref, attempt_ref, score_record_ref, generated_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (attempt_ref, score_record_ref) DO NOTHING`,
        [report.reportId, report.learnerRef, report.attemptRef, report.scoreRecordRef, report.generatedAt],
      );
      if (rowCount === 1) {
        for (const f of report.findings) {
          await client.query(
            `INSERT INTO learning.report_finding (report_id, rank, concept_identity_id, taxonomy_version_id, marks_lost, marks_available, slot_count, skipped_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [report.reportId, f.rank, f.conceptIdentityId, f.taxonomyVersionId, f.marksLost, f.marksAvailable, f.slots, f.skipped],
          );
        }
      }
      await client.query('COMMIT');
      outcome = ok(rowCount === 1);
    } catch {
      await client.query('ROLLBACK');
      outcome = err(unavailable());
    }
    client.release();
    return outcome;
  }

  async latest(learnerRef: string, attemptRef: string): Promise<Result<StoredReport | null, ApplicationError>> {
    try {
      const head = await this.#pool.query<{ report_id: string; score_record_ref: string; generated_at: Date }>(
        'SELECT report_id, score_record_ref, generated_at FROM learning.diagnostic_report WHERE learner_ref = $1 AND attempt_ref = $2 ORDER BY report_seq DESC LIMIT 1',
        [learnerRef, attemptRef],
      );
      const row = head.rows[0];
      if (row === undefined) return ok(null);
      const found = await this.#pool.query<{ rank: number; concept_identity_id: string; taxonomy_version_id: string; marks_lost: string; marks_available: string; slot_count: number; skipped_count: number }>(
        'SELECT rank, concept_identity_id, taxonomy_version_id, marks_lost::text, marks_available::text, slot_count, skipped_count FROM learning.report_finding WHERE report_id = $1 ORDER BY rank',
        [row.report_id],
      );
      const findings: Finding[] = found.rows.map((f) =>
        Object.freeze({ rank: f.rank, conceptIdentityId: f.concept_identity_id, taxonomyVersionId: f.taxonomy_version_id, marksLost: trimmed(f.marks_lost), marksAvailable: trimmed(f.marks_available), slots: f.slot_count, skipped: f.skipped_count }),
      );
      return ok(Object.freeze({ reportId: row.report_id, learnerRef, attemptRef, scoreRecordRef: row.score_record_ref, generatedAt: row.generated_at.toISOString(), findings: Object.freeze(findings) }));
    } catch {
      return err(unavailable());
    }
  }
}
