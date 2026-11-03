import type { Pool } from 'pg';
import { applicationError, type ApplicationError } from '../application/authorization.js';
import type { LearnerProfileStore } from '../application/ports.js';
import type { CurrentClass, LearnerProfile } from '../domain/learner-profile.js';
import { err, ok, type Result } from '../domain/result.js';

interface ProfileRow {
  readonly learner_ref: string;
  readonly exam_code: string | null;
  readonly target_year: string | null;
  readonly exam_profile_version_id: string | null;
  readonly taxonomy_version_id: string | null;
  readonly current_class: CurrentClass | null;
  readonly prior_score_value: string | null;
  readonly prior_score_out_of: string | null;
  readonly scope_taxonomy_version_id: string | null;
  readonly scope_node_ids: string[] | null;
  readonly scope_concept_ids: string[] | null;
  readonly scope_concept_total: number | null;
  readonly onboarding_skipped_at: Date | null;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const COLUMNS = `learner_ref, exam_code, target_year, exam_profile_version_id, taxonomy_version_id, current_class, prior_score_value, prior_score_out_of, scope_taxonomy_version_id,
  scope_node_ids, scope_concept_ids, scope_concept_total, onboarding_skipped_at, version, created_at, updated_at`;

const toProfile = (row: ProfileRow): LearnerProfile =>
  Object.freeze({
    learnerRef: row.learner_ref,
    exam:
      row.exam_code === null
        ? null
        : Object.freeze({ examCode: row.exam_code, targetYear: row.target_year!, examProfileVersionId: row.exam_profile_version_id!, taxonomyVersionId: row.taxonomy_version_id! }),
    currentClass: row.current_class,
    priorScore: row.prior_score_value === null ? null : Object.freeze({ value: Number(row.prior_score_value), outOf: Number(row.prior_score_out_of) }),
    scope:
      row.scope_taxonomy_version_id === null
        ? null
        : Object.freeze({
            taxonomyVersionId: row.scope_taxonomy_version_id,
            nodeIds: Object.freeze([...row.scope_node_ids!]),
            conceptIdentityIds: Object.freeze([...row.scope_concept_ids!]),
            conceptTotal: row.scope_concept_total!,
          }),
    onboardingSkippedAt: row.onboarding_skipped_at === null ? null : row.onboarding_skipped_at.toISOString(),
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });

const unavailable = (): ApplicationError => applicationError('Unavailable', 'PROFILE_UNAVAILABLE', "the learner's profile could not be read or written");

/** The values of a profile as the columns take them, after the key. */
const columnsOf = (profile: LearnerProfile): unknown[] => [
  profile.exam?.examCode ?? null,
  profile.exam?.targetYear ?? null,
  profile.exam?.examProfileVersionId ?? null,
  profile.exam?.taxonomyVersionId ?? null,
  profile.currentClass,
  profile.priorScore?.value ?? null,
  profile.priorScore?.outOf ?? null,
  profile.scope?.taxonomyVersionId ?? null,
  profile.scope === null ? null : [...profile.scope.nodeIds],
  profile.scope === null ? null : [...profile.scope.conceptIdentityIds],
  profile.scope?.conceptTotal ?? null,
  profile.onboardingSkippedAt,
  profile.updatedAt,
];

/** One row per learner, read and written by the learner's own key only. */
export class PostgresLearnerProfileStore implements LearnerProfileStore {
  constructor(private readonly pool: Pool) {}

  async find(learnerRef: string): Promise<Result<LearnerProfile | null, ApplicationError>> {
    try {
      const { rows } = await this.pool.query<ProfileRow>(`SELECT ${COLUMNS} FROM learning.learner_profile WHERE learner_ref = $1`, [learnerRef]);
      return ok(rows[0] === undefined ? null : toProfile(rows[0]));
    } catch {
      return err(unavailable());
    }
  }

  /**
   * A first save inserts, and a later one replaces the version it was read at: the statement matches on that version, so a save made over a profile that has since moved on changes
   * nothing and is a `Conflict`. A first save that finds the row already there (two tabs, both first) is one too.
   */
  async save(profile: LearnerProfile, expectedVersion: number | null): Promise<Result<LearnerProfile, ApplicationError>> {
    try {
      const conflict = err(applicationError('Conflict', 'PROFILE_CHANGED', 'the profile was changed by something else; read it again'));
      if (expectedVersion === null) {
        const { rows } = await this.pool.query<ProfileRow>(
          `INSERT INTO learning.learner_profile (learner_ref, exam_code, target_year, exam_profile_version_id, taxonomy_version_id, current_class, prior_score_value, prior_score_out_of,
             scope_taxonomy_version_id, scope_node_ids, scope_concept_ids, scope_concept_total, onboarding_skipped_at, updated_at, version, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           ON CONFLICT (learner_ref) DO NOTHING
           RETURNING ${COLUMNS}`,
          [profile.learnerRef, ...columnsOf(profile), profile.version, profile.createdAt],
        );
        return rows[0] === undefined ? conflict : ok(toProfile(rows[0]));
      }
      const { rows } = await this.pool.query<ProfileRow>(
        `UPDATE learning.learner_profile SET exam_code = $2, target_year = $3, exam_profile_version_id = $4, taxonomy_version_id = $5, current_class = $6, prior_score_value = $7,
           prior_score_out_of = $8, scope_taxonomy_version_id = $9, scope_node_ids = $10, scope_concept_ids = $11, scope_concept_total = $12, onboarding_skipped_at = $13, updated_at = $14,
           version = $15
         WHERE learner_ref = $1 AND version = $16
         RETURNING ${COLUMNS}`,
        [profile.learnerRef, ...columnsOf(profile), profile.version, expectedVersion],
      );
      return rows[0] === undefined ? conflict : ok(toProfile(rows[0]));
    } catch {
      return err(unavailable());
    }
  }
}
