/**
 * `StudySession` — a learner's sitting (M7-13, DEC-M7-2).
 *
 * D-002 reads "2 distinct sessions" and "verified in a different session", and means a *learner's* sitting: a window of activity closed by an idle gap.
 * It is not assessment's `form_session`, which is a sitting a form declares and is called a **shift** in prose (DOMAIN-MODEL, §0).
 *
 * **Sessions are made of response instants**, `MasteryEvidence.occurredAt` (M7-11), never of attempts. That is what makes the count the same for a mock
 * attempt and a practice run, and it is the only thing that can tell a real implementation from a per-attempt stand-in: one pausable run resumed after a
 * gap larger than the idle gap is **two** sessions, and two attempts a minute apart are **one**.
 *
 * **The rule.** Two instants belong to one session when they are no more than the idle gap apart, directly or through the instants between them; a gap
 * *larger* than the idle gap closes a session. The boundary is inclusive: an instant exactly one idle gap after the last is still in the sitting.
 *
 * **Assigned as evidence arrives, in any order.** `placeInSession` takes a learner's sessions and one new instant and says which session it joins. An
 * instant that falls within the gap of two sessions bridges them, and they become one: the earlier keeps its identity and the later's is reported as absorbed
 * so a store can reassign its evidence. The partition this produces depends on the instants and not on the order they were placed in, which a spec holds to
 * a batch derivation over random permutations. A session once formed is never split: publishing a smaller idle gap does not reach back.
 *
 * The idle gap is the rule set's (`session.idleGapMinutes`), a parameter here and not a constant.
 */
export interface StudySession {
  readonly sessionId: string;
  /** The earliest response instant in the session, ISO-8601 UTC. */
  readonly startedAt: string;
  /** The latest response instant in the session. */
  readonly endedAt: string;
}

export interface Placement {
  /** The learner's sessions after the instant was placed, earliest first. */
  readonly sessions: readonly StudySession[];
  /** The session the instant belongs to. */
  readonly sessionId: string;
  /** Sessions the instant bridged into `sessionId`; their evidence now belongs to it. */
  readonly absorbed: readonly string[];
}

const MINUTE_MS = 60_000;

const at = (instant: string): number => Date.parse(instant);

/**
 * Places one response instant. `newSessionId` is what a new session is named if one is needed, supplied by the caller because the domain mints no
 * identifiers.
 */
export function placeInSession(
  sessions: readonly StudySession[],
  instant: string,
  idleGapMinutes: number,
  newSessionId: string,
): Placement {
  const t = at(instant);
  const gap = idleGapMinutes * MINUTE_MS;
  const near = sessions.filter((s) => t >= at(s.startedAt) - gap && t <= at(s.endedAt) + gap).sort((a, b) => at(a.startedAt) - at(b.startedAt));
  const others = sessions.filter((s) => !near.includes(s));

  if (near.length === 0) {
    const created: StudySession = Object.freeze({ sessionId: newSessionId, startedAt: instant, endedAt: instant });
    return Object.freeze({ sessions: sorted([...others, created]), sessionId: newSessionId, absorbed: Object.freeze([]) });
  }

  const [keep, ...merged] = near as [StudySession, ...StudySession[]];
  const all = [keep, ...merged];
  const startedAt = [instant, ...all.map((s) => s.startedAt)].reduce((a, b) => (at(a) <= at(b) ? a : b));
  const endedAt = [instant, ...all.map((s) => s.endedAt)].reduce((a, b) => (at(a) >= at(b) ? a : b));
  const joined: StudySession = Object.freeze({ sessionId: keep.sessionId, startedAt, endedAt });
  return Object.freeze({
    sessions: sorted([...others, joined]),
    sessionId: keep.sessionId,
    absorbed: Object.freeze(merged.map((s) => s.sessionId)),
  });
}

function sorted(sessions: StudySession[]): readonly StudySession[] {
  return Object.freeze([...sessions].sort((a, b) => at(a.startedAt) - at(b.startedAt)));
}
