import { err, ok, type Result } from './result.js';
import { preconditionFailedError, type ScoringError } from './scoring-error.js';
import { scoreAttempt, type ScoreAttemptError, type ScoreAttemptProps } from './score-attempt.js';
import type { ScoreRecord } from './score-record.js';

/**
 * The executor must support every historical `rule_schema_version` forever
 * (ASSESSMENT-ENGINE §3, R2, F48).
 *
 * A `ScoreRecord` pins the schema version its rules were written under. Years
 * later, a re-score of that attempt has to reproduce the same number — which
 * it can only do if the code that produced it is still reachable. So versions
 * are added to this registry and **never removed**: dropping one silently
 * turns every historical record it produced into something the system can no
 * longer reproduce or defend.
 */

export type ScoringExecutor = (props: ScoreAttemptProps) => Result<ScoreRecord, ScoreAttemptError>;

/**
 * Every schema version ever shipped. Append only — this list is the record of
 * what the engine has promised to keep scoring, and `schema-version-registry.spec.ts`
 * fails if any entry loses its executor.
 */
export const SHIPPED_SCHEMA_VERSIONS: readonly number[] = Object.freeze([1]);

const EXECUTORS: ReadonlyMap<number, ScoringExecutor> = new Map<number, ScoringExecutor>([[1, scoreAttempt]]);

export type SchemaVersionErrorCode = 'RULE_SCHEMA_VERSION_UNSUPPORTED';

export type SchemaVersionError = ScoringError<SchemaVersionErrorCode>;

export function registeredVersions(): readonly number[] {
  return [...EXECUTORS.keys()].sort((left, right) => left - right);
}

export function executorFor(
  schemaVersion: number,
  registry: ReadonlyMap<number, ScoringExecutor> = EXECUTORS,
): Result<ScoringExecutor, SchemaVersionError> {
  const executor = registry.get(schemaVersion);
  if (executor === undefined) {
    // Fail closed (§8). A best-effort score under the nearest version it does
    // know would be a number nobody authored and nobody can defend.
    return err(
      preconditionFailedError(
        'RULE_SCHEMA_VERSION_UNSUPPORTED',
        `no executor is registered for rule schema version ${schemaVersion}`,
      ),
    );
  }
  return ok(executor);
}

/**
 * Scores under the version the attempt was pinned to, not under whatever
 * version happens to be current.
 */
export function scoreAttemptAtPinnedVersion(
  props: ScoreAttemptProps,
): Result<ScoreRecord, ScoreAttemptError | SchemaVersionError> {
  const executor = executorFor(props.input.pin.ruleSchemaVersion);
  if (!executor.ok) return err(executor.error);
  return executor.value(props);
}
