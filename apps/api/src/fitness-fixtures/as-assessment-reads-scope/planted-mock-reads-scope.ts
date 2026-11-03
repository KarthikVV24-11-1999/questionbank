import type { LearnerScopeSource } from '../../contexts/assessment/application/ports.js';

/**
 * Planted violation for `scope-rules.spec.ts` (M8-21) — a file standing in for the mock path that takes the learner's scope. The scope source is in the same dependency bag as the
 * mock handlers' own, so this compiles; the rule is what stops it. The spec checks it as if it lived in `contexts/assessment/application/handlers/`.
 *
 * Never imported by production code.
 */
export const narrowTheMock = async (source: LearnerScopeSource, taxonomyVersionId: string): Promise<boolean> => (await source.conceptsInScope(taxonomyVersionId, undefined as never)).ok;
