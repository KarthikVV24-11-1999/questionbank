import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ok, err, type Result } from '../domain/result.js';
import { Exam, type ExamId } from '../domain/exam.js';
import {
  conflict,
  corruptRow,
  notFound,
  type Persisted,
  type RepositoryError,
} from '../domain/repository-ports.js';
import { exam, examProfileVersion } from './schema.js';

type ExamRow = typeof exam.$inferSelect;

export function toExamRow(subject: Exam): typeof exam.$inferInsert {
  return {
    examId: subject.examId,
    code: subject.code,
    displayName: subject.displayName,
    jurisdiction: subject.jurisdiction,
    conductingBody: subject.conductingBody,
  };
}

/**
 * Active profile versions live on `exam_profile_version.is_active`, where a
 * partial unique index enforces one per exam-year; the `Exam` aggregate carries
 * the same fact in memory, so this repository projects the flag back onto it.
 */
export function toExam(
  row: ExamRow,
  activeVersions: ReadonlyArray<{ academicYear: string; profileVersionId: string }>,
): Result<Exam, RepositoryError> {
  const created = Exam.create({
    examId: row.examId,
    code: row.code,
    displayName: row.displayName,
    jurisdiction: row.jurisdiction,
    conductingBody: row.conductingBody,
  });
  if (!created.ok) return err(corruptRow(`exam ${row.examId} cannot be loaded: ${created.error.message}`));

  let subject = created.value;
  for (const active of activeVersions) {
    const activated = subject.activateProfileVersion(active.academicYear, active.profileVersionId);
    if (!activated.ok) {
      return err(corruptRow(`exam ${row.examId} cannot be loaded: ${activated.error.message}`));
    }
    subject = activated.value;
  }

  return ok(subject);
}

export class DrizzleExamRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async insert(subject: Exam): Promise<Result<Persisted<Exam>, RepositoryError>> {
    await this.db.insert(exam).values({ ...toExamRow(subject), aggregateVersion: 1 });
    return ok({ aggregate: subject, aggregateVersion: 1 });
  }

  async update(
    subject: Exam,
    expectedAggregateVersion: number,
  ): Promise<Result<Persisted<Exam>, RepositoryError>> {
    const nextVersion = expectedAggregateVersion + 1;
    const rows = await this.db
      .update(exam)
      .set({ ...toExamRow(subject), aggregateVersion: nextVersion })
      .where(and(eq(exam.examId, subject.examId), eq(exam.aggregateVersion, expectedAggregateVersion)))
      .returning();

    return rows.length === 0
      ? err(
          conflict(
            `exam ${subject.examId} was modified by someone else: expected aggregate version ${expectedAggregateVersion}`,
          ),
        )
      : ok({ aggregate: subject, aggregateVersion: nextVersion });
  }

  async findById(examId: ExamId): Promise<Result<Persisted<Exam>, RepositoryError>> {
    const rows = await this.db.select().from(exam).where(eq(exam.examId, examId));
    const row = rows[0];
    if (row === undefined) return err(notFound(`exam ${examId} not found`));

    const active = await this.db
      .select({
        academicYear: examProfileVersion.academicYear,
        profileVersionId: examProfileVersion.profileVersionId,
      })
      .from(examProfileVersion)
      .where(and(eq(examProfileVersion.examId, examId), eq(examProfileVersion.isActive, true)));

    const loaded = toExam(row, active);
    return loaded.ok ? ok({ aggregate: loaded.value, aggregateVersion: row.aggregateVersion }) : loaded;
  }

  async list(): Promise<readonly Persisted<Exam>[]> {
    const rows = await this.db.select().from(exam);

    const loaded: Persisted<Exam>[] = [];
    for (const row of rows) {
      const found = await this.findById(row.examId);
      if (found.ok) loaded.push(found.value);
    }
    return loaded;
  }
}
