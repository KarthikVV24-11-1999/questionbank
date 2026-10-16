/**
 * Planted violations for `generation-rules.spec.ts` (M5-20).
 *
 * An event that carries the proposal, and a handler that invents the
 * principal and the correlation id the application context should supply.
 * Never imported by production code.
 */
import { randomUUID } from 'node:crypto';

export interface PlantedLeakyEvent {
  readonly eventType: 'CandidateAccepted';
  readonly candidateId: string;
  readonly stem: string;
  readonly correctOptionId: string;
  readonly solution: { readonly steps: readonly string[] };
}

export function inventedEnvelope() {
  return {
    principal: { kind: 'system', id: randomUUID() },
    correlationId: 'made-up',
  };
}
