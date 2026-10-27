import { describe, expect, it } from 'vitest';
import { thresholdsWith, D002_THRESHOLDS } from '../../../testing/learning-thresholds.js';
import { placeInSession, type StudySession } from './study-session.js';

const GAP = D002_THRESHOLDS.session.idleGapMinutes;
const base = Date.UTC(2026, 9, 21, 9, 0, 0);
const t = (minutes: number) => new Date(base + minutes * 60_000).toISOString();

/** Places instants one after another, naming new sessions s1, s2, ... as they are needed. */
function placeAll(instants: readonly string[], gap = GAP) {
  let sessions: readonly StudySession[] = [];
  let next = 0;
  const assigned: { instant: string; sessionId: string; absorbed: readonly string[] }[] = [];
  for (const instant of instants) {
    next += 1;
    const placed = placeInSession(sessions, instant, gap, `s${next}`);
    sessions = placed.sessions;
    assigned.push({ instant, sessionId: placed.sessionId, absorbed: placed.absorbed });
  }
  return { sessions, assigned };
}

/** The partition as a set of sets of instants, so orders and names do not matter. */
const partitionOf = (sessions: readonly StudySession[], instants: readonly string[]) =>
  sessions
    .map((s) => instants.filter((i) => Date.parse(i) >= Date.parse(s.startedAt) && Date.parse(i) <= Date.parse(s.endedAt)).sort())
    .map((group) => group.join('|'))
    .sort();

describe('a learner\'s sitting is made of response instants', () => {
  it('is one session for a mock attempt answered in one evening: the instants are minutes apart', () => {
    const { sessions } = placeAll([t(0), t(4), t(9), t(15), t(40), t(66)]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ startedAt: t(0), endedAt: t(66) });
  });

  it('is TWO sessions for one pausable run resumed after a gap larger than the idle gap: the case a per-attempt stand-in gets wrong', () => {
    // one attempt's evidence, paused for three days in the middle
    const run = [t(0), t(10), t(25), t(3 * 24 * 60), t(3 * 24 * 60 + 8)];
    const { sessions, assigned } = placeAll(run);
    expect(sessions).toHaveLength(2);
    expect(new Set(assigned.map((a) => a.sessionId)).size).toBe(2);
    expect(assigned.slice(0, 3).every((a) => a.sessionId === assigned[0]!.sessionId)).toBe(true);
    expect(assigned.slice(3).every((a) => a.sessionId === assigned[3]!.sessionId)).toBe(true);
  });

  it('is ONE session for two separate attempts a minute apart, so it counts attempts as nothing', () => {
    // the end of one attempt and the start of the next
    expect(placeAll([t(0), t(20), t(21), t(22), t(50)]).sessions).toHaveLength(1);
  });

  it('closes on a gap larger than the idle gap and not on one exactly as large', () => {
    expect(placeAll([t(0), t(GAP)]).sessions).toHaveLength(1);
    expect(placeAll([t(0), t(GAP + 1)]).sessions).toHaveLength(2);
    // measured from the last instant in the session, not the first: a long sitting of short gaps is one session
    expect(placeAll(Array.from({ length: 20 }, (_, i) => t(i * GAP))).sessions).toHaveLength(1);
  });

  it('takes its idle gap from the rule set: a wider gap joins what a narrower one separates', () => {
    const instants = [t(0), t(120)];
    expect(placeAll(instants, GAP).sessions).toHaveLength(2);
    expect(placeAll(instants, thresholdsWith({ session: { idleGapMinutes: 180 } }).session.idleGapMinutes).sessions).toHaveLength(1);
  });
});

describe('evidence that arrives out of order', () => {
  it('joins the session it falls inside, and extends one it falls just before', () => {
    const { sessions, assigned } = placeAll([t(100), t(110), t(105), t(80)]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ startedAt: t(80), endedAt: t(110) });
    expect(new Set(assigned.map((a) => a.sessionId)).size).toBe(1);
  });

  it('bridges two sessions when an instant falls within the gap of both, keeping the earlier and reporting the later as absorbed', () => {
    const { sessions, assigned } = placeAll([t(0), t(50), t(25)]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: 's1', startedAt: t(0), endedAt: t(50) });
    expect(assigned[2]).toMatchObject({ sessionId: 's1', absorbed: ['s2'] });
  });

  it('never splits a session once formed', () => {
    const { sessions } = placeAll([t(0), t(20), t(40)]);
    const again = placeInSession(sessions, t(41), 5, 'new');
    expect(again.sessions).toHaveLength(1);
    expect(again.sessionId).toBe('s1');
  });

  it('gives the same partition for every order the instants arrive in: 300 random permutations against the batch partition', () => {
    const instants = [0, 5, 20, 33, 60, 95, 96, 140, 200, 201, 202, 260, 400].map(t);
    const reference = partitionOf(placeAll(instants).sessions, instants);
    expect(reference.length).toBeGreaterThan(2);
    let state = 1;
    const next = (n: number) => {
      state = (state + 0x6d2b79f5) >>> 0;
      let x = state;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * n);
    };
    for (let round = 0; round < 300; round += 1) {
      const shuffled = [...instants];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = next(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(partitionOf(placeAll(shuffled).sessions, instants), `round ${round}`).toEqual(reference);
    }
  });

  it('is learner-scoped by construction: it sees only the sessions it is given', () => {
    const mine = placeAll([t(0)]).sessions;
    const theirs = placeAll([t(1000)]).sessions;
    expect(placeInSession(mine, t(1), GAP, 'x').sessions).toHaveLength(1);
    expect(placeInSession(theirs, t(1), GAP, 'x').sessions).toHaveLength(2);
  });

  it('returns frozen values, earliest session first', () => {
    const { sessions } = placeAll([t(500), t(0)]);
    expect(sessions.map((s) => s.startedAt)).toEqual([t(0), t(500)]);
    expect(Object.isFrozen(sessions)).toBe(true);
    expect(Object.isFrozen(sessions[0])).toBe(true);
  });
});
