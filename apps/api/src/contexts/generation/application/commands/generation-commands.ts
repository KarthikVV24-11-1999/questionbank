/**
 * What the generation context can be told to do to a candidate. Types only —
 * the handlers that execute them are Track B's.
 */
export interface AcceptCandidate {
  readonly candidateId: string;
}

export interface RejectCandidate {
  readonly candidateId: string;
}
