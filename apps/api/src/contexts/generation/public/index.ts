/**
 * The generation context's only public surface: commands, queries and events.
 * No aggregate, no repository, no handler, no infrastructure type
 * (ENGINEERING-HANDBOOK §1, §9 rule 1).
 *
 * Nothing in `content`, `curriculum` or `scoring` may import this file —
 * generation is downstream of content and nothing points back (ADR-0025,
 * enforced by `fitness/generation-rules.ts`).
 *
 * There are no queries yet.
 */

// ── Commands ────────────────────────────────────────────────────────────────
export type { AcceptCandidate, RejectCandidate } from '../application/commands/generation-commands.js';

// ── Vocabulary a consumer branches on ───────────────────────────────────────
export { CANDIDATE_STATES } from '../domain/generation-candidate.js';
export type { CandidateState } from '../domain/generation-candidate.js';
export type { ModelPin } from '../domain/model-pin.js';

// ── Events ──────────────────────────────────────────────────────────────────
export { GENERATION_EVENT_TYPES } from '../domain/events/generation-events.js';
export type {
  CandidateAccepted,
  CandidateRejected,
  GenerationEvent,
  GenerationEventType,
} from '../domain/events/generation-events.js';
