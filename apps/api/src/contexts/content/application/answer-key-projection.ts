import {
  createAnswerKey,
  isKnownItemType,
  KEY_KIND_BY_ITEM_TYPE,
  type AnswerKey,
  type AnswerKeyData,
  type MatchedPair,
} from '../../scoring/public/index.js';
import type { ResponseSpecification } from '../domain/response-specification.js';
import { err, ok, type Result } from '../domain/result.js';
import { validationError, type ContentError } from '../domain/content-error.js';

/**
 * The M3 → M2 seam: an authored `ResponseSpecification` becomes the
 * `AnswerKeyData` the executor consumes (DEC-3).
 *
 * **Why this lives in `application/` and not `domain/`.** `domain/` imports
 * nothing — not another context, not even through a barrel (§9 rule 2, F2).
 * The projection has to reach `scoring/public/` to validate against the
 * executor's own constructors, so it sits one layer out. That is the right
 * place regardless: this is a seam between two contexts, and a seam is not a
 * domain concept.
 *
 * **The projection is validated by the barrel, not by hand.** A hand-written
 * shape check here would pass keys the executor later refuses — at scoring
 * time, for a real candidate. Two gates run, both scoring's own:
 *
 *   `isKnownItemType`  — the executor can score this item type at all. This is
 *                        the drift gate: content gaining a type that scoring
 *                        does not know fails here rather than when a real
 *                        attempt is scored
 *   `createAnswerKey`  — the key is internally coherent (D-001 rule 5: a
 *                        comparison mode missing its parameter is invalid)
 *
 * The third pairing — key variant against item type — is `checkKeyMatchesItemType`,
 * which the barrel exposes only inside `createScoringInput`. It is **not** run
 * here, because `toAnswerKeyData` derives the variant *from* the item type via
 * `KEY_KIND_BY_ITEM_TYPE`, so the two cannot disagree; a probe input would be a
 * branch nothing could reach. The pairing is asserted in the spec instead,
 * where a real `createScoringInput` accepts each of the four types.
 *
 * **The projection is one-way.** Nothing reconstructs a specification from an
 * answer key: the specification carries presentation the key does not have, so
 * a reverse function could only invent it. The spec asserts none exists.
 *
 * **Nothing here reaches a client.** This module produces answer keys; only
 * the authoring DTO family may carry one (ADR-0009).
 */

export type ProjectionErrorCode = 'ANSWER_KEY_REJECTED_BY_EXECUTOR' | 'ITEM_TYPE_NOT_SCORABLE';

export type ProjectionError = ContentError<ProjectionErrorCode>;

/** The key half of a specification, in the shape `scoring/public/` names. */
export function toAnswerKeyData(spec: ResponseSpecification): AnswerKeyData {
  switch (spec.itemType) {
    case 'SINGLE_CORRECT_MCQ':
      return { kind: KEY_KIND_BY_ITEM_TYPE.SINGLE_CORRECT_MCQ, optionId: spec.correctOptionId };

    case 'MULTIPLE_CORRECT_MCQ':
      return {
        kind: KEY_KIND_BY_ITEM_TYPE.MULTIPLE_CORRECT_MCQ,
        correctOptionIds: [...spec.correctOptionIds],
      };

    case 'MATCHING': {
      const pairs: MatchedPair[] = spec.pairs.map((pair) => ({ left: pair.left, right: pair.right }));
      return { kind: KEY_KIND_BY_ITEM_TYPE.MATCHING, pairs };
    }

    case 'NUMERIC':
      // The authored decimal literal crosses as text, unchanged. Reading it
      // through a JavaScript number anywhere on this path would discard the
      // exactness ADR-0007 exists to keep, and `SIGNIFICANT_FIGURES` counts
      // figures in the literal itself.
      return { kind: KEY_KIND_BY_ITEM_TYPE.NUMERIC, spec: spec.spec };
  }
}

/**
 * Projects the key and validates it the way the executor will.
 *
 * A specification that fails here is one the executor would refuse, so it is
 * refused at authoring instead — the only place a human can still fix it
 * cheaply, and long before a candidate's mark depends on it.
 */
export function projectAnswerKey(
  spec: ResponseSpecification,
  location = 'responseSpec',
): Result<AnswerKeyData, ProjectionError> {
  const projected = project(spec, location);
  return projected.ok ? ok(projected.value.data) : err(projected.error);
}

/**
 * The same projection, returning the **validated** key rather than the stored
 * data.
 *
 * M3-14 needs an `AnswerKey` to hand to the executor's `evaluateExactMatch`.
 * Calling `createAnswerKey` a second time on data this module already
 * validated would be duplicate work whose failure branch nothing could reach —
 * so the one validation is shared instead.
 */
export function projectValidatedAnswerKey(
  spec: ResponseSpecification,
  location = 'responseSpec',
): Result<AnswerKey, ProjectionError> {
  const projected = project(spec, location);
  return projected.ok ? ok(projected.value.key) : err(projected.error);
}

/**
 * DEC-3's guarantee, as a guard on the write path: **a specification whose
 * projection the executor refuses cannot be saved.**
 *
 * Without this the refusal happens at the database, as a CHECK constraint
 * violation — which reaches the author as a Postgres message naming a
 * constraint, and reaches an import report as `PERSISTENCE_REJECTED`. Neither
 * says "this numeric item has no tolerance", which is the one thing the author
 * needs to know. Found by M3-45's corpus.
 */
export function checkSpecificationIsScorable(
  spec: ResponseSpecification,
  location = 'version.responseSpec',
): Result<true, ProjectionError> {
  const projected = project(spec, location);
  return projected.ok ? ok(true) : err(projected.error);
}

function project(
  spec: ResponseSpecification,
  location: string,
): Result<{ readonly data: AnswerKeyData; readonly key: AnswerKey }, ProjectionError> {
  // The drift gate. Content's vocabulary and scoring's are asserted equal in
  // the spec; this is what happens if one of them moves anyway.
  if (!isKnownItemType(spec.itemType)) {
    return err(
      validationError(
        'ITEM_TYPE_NOT_SCORABLE',
        `the scoring executor has no answer-key variant for item type "${spec.itemType}"`,
        location,
      ),
    );
  }

  const data = toAnswerKeyData(spec);
  const key = createAnswerKey(data);

  if (!key.ok) {
    return err(
      validationError(
        'ANSWER_KEY_REJECTED_BY_EXECUTOR',
        `the scoring executor refuses this answer key: ${key.error.code} — ${key.error.message}`,
        location,
      ),
    );
  }

  return ok({ data, key: key.value });
}

/**
 * Whether the executor accepts this specification's key at all. Pre-submission
 * validation (M3-17) and the publication precondition (M3-11) both want the
 * verdict rather than the key — and neither should hold a key it does not need.
 */
export function isKeyAcceptedByExecutor(spec: ResponseSpecification): boolean {
  return projectAnswerKey(spec).ok;
}
