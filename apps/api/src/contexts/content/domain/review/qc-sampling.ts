import { createHash } from 'node:crypto';
import type { PrincipalRef } from '@questionbank/domain-types';
import type { SelfReviewableVersion } from './self-review.js';

/**
 * QC sampling (DEC-M4-14, §C.6) — deterministic, reproducible years later,
 * and never on the critical path of the approval it samples.
 *
 * **Deterministic, not random.** `isSampled` hashes the decision id and
 * compares a fixed slice of the digest against the policy's rate — no clock,
 * no `Math.random`, so a disputed sample can be re-derived from the same
 * `decisionId` at any point afterward and get the same answer.
 *
 * **A sampled approval is not blocked.** This module has no function that
 * returns a `Result`, refuses a transition, or otherwise gates anything —
 * `qc-sampling.spec.ts` asserts the module's exports are exactly `isSampled`
 * and `secondReviewerExcludes`, neither of which the publication path or the
 * decision handler could mistake for a precondition. Sampling is a
 * measurement taken after the fact; blocking on it would put a second
 * reviewer on the critical path of one approval in twenty and destroy the
 * throughput the milestone exists to produce (DEC-M4-14).
 */

export interface ReviewSamplingPolicy {
  readonly sampleRate: number;
}

/**
 * The leading 32 bits of `sha256(decisionId)`, read as an unsigned integer
 * and compared against `sampleRate` scaled to the same range — a uniform,
 * deterministic draw with no randomness in the domain.
 */
export function isSampled(decisionId: string, policy: ReviewSamplingPolicy): boolean {
  const digest = createHash('sha256').update(decisionId, 'utf8').digest();
  const leadingBits = digest.readUInt32BE(0);
  const threshold = policy.sampleRate * 0x1_0000_0000;
  return leadingBits < threshold;
}

export interface SampledDecisionContext {
  readonly reviewer: PrincipalRef;
  readonly version: SelfReviewableVersion;
}

/**
 * The principals a second reviewer must not be — the original reviewer, the
 * version's author, and its editor (if `approve_with_edits` set one). Not a
 * decision about who *is* eligible; the assignment step (M4-27) resolves
 * that against the reviewer pool.
 */
export function secondReviewerExcludes(context: SampledDecisionContext): readonly PrincipalRef[] {
  const excluded = [context.reviewer, context.version.authoredBy];
  if (context.version.editedBy !== undefined) excluded.push(context.version.editedBy);
  return excluded;
}
