/**
 * Planted violations for `generation-rules.spec.ts` (M5-41, F32): the ways an AI
 * call site fails to declare a budget scope. Never imported by production code.
 */
import type { JudgementProvider, ProposalProvider, ProposalRequest } from '../../contexts/generation/application/ports.js';

declare const proposals: ProposalProvider;
declare const judges: JudgementProvider;
declare const request: ProposalRequest;

// No scope anywhere in the arguments.
export const unscopedJudgement = judges.judge({ modelVersionId: 'm', promptVersionId: 'p', input: {} } as never);

// A bare identifier: the declaration, if any, is somewhere the call site does not show.
export const unscopedProposal = proposals.propose(request);

// Names the scope, so it is the one call here that is not a violation.
export const scopedJudgement = judges.judge({ budgetScope: { feature: 'generation', runId: 'r' }, modelVersionId: 'm', promptVersionId: 'p', input: {} });
