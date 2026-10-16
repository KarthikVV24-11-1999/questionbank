import type { AuthoredItemContent } from '../../../content/public/index.js';
import { err, ok } from '../../domain/result.js';
import type { VersionRegistry } from '../../domain/repository-ports.js';
import { fromGeneration } from '../authorization.js';
import { toAiProvenance } from '../content-draft-acl.js';
import type { CheckOutcome, PrecheckRunner } from './battery.js';

/**
 * Check 12 — provenance and licensing completeness (AI-ARCHITECTURE §11,
 * blocking). Deterministic, and generation owns every input: the pin is on the
 * candidate, the registry rows are generation's own, and the licensing is in the
 * proposal. The one blocking check this context can close entirely by itself.
 *
 * It asks three questions, and a candidate fails if any answer is no:
 *
 *   1. **Does the pin name rows that exist?** The database refuses a candidate
 *      pinned to a missing version, so a stored candidate always passes this —
 *      but the check does not lean on that, because a verdict is only worth
 *      something if the check was actually made.
 *   2. **Would content take the provenance?** Answered by the very function the
 *      anti-corruption layer builds the draft's provenance with, not a copy of
 *      it. The check and the ACL therefore cannot disagree: whatever this
 *      passes, accept will not refuse on provenance grounds.
 *   3. **Is the licensing complete?** Content blocks publication while licensing
 *      is unresolved, and a licensed item must say under what licence and with
 *      what attribution. A proposal that would arrive at content with licensing
 *      it must immediately be sent back for is a generation wasted.
 *
 * The licensing rules are content's, restated here because content exposes no
 * validator over a proposal (the same gap that blocks checks 1, 2, 4 and 8).
 * Restating a rule is the drift this repository has been bitten by, so the
 * statuses are typed against content's own and a parity test in the composition
 * tree holds this function to content's real `createLicensingStatus`.
 */

type Licensing = NonNullable<AuthoredItemContent['licensing']>;
type Status = Licensing['status'];

/** Statuses that publish. `unresolved` is the one that does not — see below. */
export const RESOLVED_LICENSING_STATUSES = ['owned', 'licensed', 'public_domain'] as const satisfies readonly Status[];

/** A status added to content's vocabulary and not here is a compile error, not a silent hole. */
type EveryContentStatusIsClassified = Status extends (typeof RESOLVED_LICENSING_STATUSES)[number] | 'unresolved' ? true : never;
export const LICENSING_VOCABULARY_IS_CLASSIFIED: EveryContentStatusIsClassified = true;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

/** What is wrong with a proposal's licensing, as sentences. Empty means complete. */
export function licensingProblems(licensing: unknown): string[] {
  if (typeof licensing !== 'object' || licensing === null || Array.isArray(licensing)) {
    return ['the proposal carries no licensing, which content treats as unresolved and will not publish'];
  }
  const { status, licenseRef, attribution, expiresAt } = licensing as Record<string, unknown>;

  if (status === 'unresolved') return ['licensing is unresolved, which blocks publication'];
  if (!(RESOLVED_LICENSING_STATUSES as readonly unknown[]).includes(status)) {
    return [`licensing status "${String(status)}" is not one content knows`];
  }

  const problems: string[] = [];
  if (status === 'licensed') {
    if (blank(licenseRef)) problems.push('a licensed item requires a licenseRef naming the licence');
    if (blank(attribution)) problems.push('a licensed item requires the attribution its licence demands');
  }
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== 'string' || !ISO_INSTANT.test(expiresAt)) {
      problems.push(`expiresAt "${String(expiresAt)}" is not an ISO-8601 instant`);
    } else if (status !== 'licensed') {
      problems.push(`status ${String(status)} does not expire; an expiry here suggests it is really a licence`);
    }
  }
  return problems;
}

export function provenanceLicensingCheck(registry: VersionRegistry): PrecheckRunner {
  return {
    check: 'provenance_licensing_completeness',
    async run(candidate) {
      const problems: string[] = [];

      const model = await registry.findModelVersion(candidate.pin.modelVersionId);
      if (!model.ok) {
        if (model.error.kind !== 'NotFound') return err(fromGeneration(model.error));
        problems.push(`the model version ${candidate.pin.modelVersionId} is not in the registry`);
      }
      const prompt = await registry.findPromptVersion(candidate.pin.promptVersionId);
      if (!prompt.ok) {
        if (prompt.error.kind !== 'NotFound') return err(fromGeneration(prompt.error));
        problems.push(`the prompt version ${candidate.pin.promptVersionId} is not in the registry`);
      }

      const provenance = toAiProvenance(candidate);
      if (!provenance.ok) problems.push(provenance.error.message);

      problems.push(...licensingProblems(candidate.content.body['licensing']));

      return ok<CheckOutcome>(
        problems.length === 0
          ? { outcome: 'pass', detail: 'the pin resolves to registry rows, content would take the provenance, and the licensing is complete' }
          : { outcome: 'fail', detail: problems.join('; ') },
      );
    },
  };
}
