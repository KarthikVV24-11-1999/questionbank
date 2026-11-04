import { describe, expect, it } from 'vitest';
import { aRig, attemptWithLogDto, stored } from '../testing/fakes.js';
import { AttemptSession } from './attempt-session.js';
import { loadRecord } from './persistence.js';

/** A practice run has no deadline (M8-24): no clock is shown, none submits it, and what is written down says so. */
const START = { attemptId: 'run-1', formId: null, deviceRef: 'd', intervalCapMs: 90_000, deadline: null, serverNow: '2026-11-04T09:00:00.000Z' };
const HOUR = 3_600_000;

describe('an attempt with no deadline', () => {
  it('has no time left to show, in the snapshot', () => {
    const { ports } = aRig();
    expect(AttemptSession.begin(START, ports).getSnapshot().remainingMs).toBeNull();
  });

  it('is never submitted by the passing of time, however long the device sleeps', async () => {
    const rig = aRig();
    // the server agrees: it has no deadline for this run, so it can never say time is up, nor correct a local clock that does
    rig.transport.getAttempt = async () => attemptWithLogDto({ attemptId: 'run-1', mode: 'practice', formId: null, durationMs: null, deadline: null });
    const session = AttemptSession.begin(START, rig.ports);
    for (const step of [HOUR, 24 * HOUR, 30 * 24 * HOUR]) {
      rig.clock.advance(step);
      await session.pump();
    }
    expect(session.getSnapshot().phase).toBe('in_progress');
    expect(rig.transport.submissions).toEqual([]);
    expect(rig.transport.submitAttempts).toBe(0);
  });

  it('still takes a submission when the learner makes one, as a paper does', async () => {
    const rig = aRig();
    const session = AttemptSession.begin(START, rig.ports);
    await session.submit('manual');
    expect(rig.transport.submissions).toEqual([{ reason: 'manual', key: 'submission:run-1' }]);
  });

  it('writes the run down with a null deadline and no form, and resumes against that, with the server unreachable', async () => {
    const rig = aRig();
    const session = AttemptSession.begin(START, rig.ports);
    session.goTo('s1');
    session.select('s1', 'b');
    await rig.records.settle();
    const record = await loadRecord(rig.records, 'run-1');
    expect(record).toMatchObject({ attemptId: 'run-1', deadline: null, formId: null });
    expect(record!.serverOffsetMs).not.toBeNull();

    const resumed = AttemptSession.resume({ record: { ...record!, serverOffsetMs: record!.serverOffsetMs! }, server: null }, aRig().ports);
    expect(resumed.getSnapshot().remainingMs).toBeNull();
    expect(resumed.getSnapshot().projection.slots.find((slot) => slot.slot === 's1')?.answer).toBe('b');
    expect((await stored(rig, 'run-1'))!.events.map((event) => event.kind)).toEqual(['visit', 'select']);
  });

  it('is still a paper\'s clock for an attempt that has a deadline: the null is the run\'s, not a default', () => {
    const { ports } = aRig();
    const paper = AttemptSession.begin({ ...START, formId: 'form-1', deadline: '2026-11-04T12:00:00.000Z' }, ports);
    expect(paper.getSnapshot().remainingMs).toBe(3 * HOUR);
  });

  it('cannot be resumed from a record that says nothing of a deadline: that is a fault, not an untimed run', () => {
    const { ports } = aRig();
    const record = { version: 1 as const, attemptId: 'x', deviceRef: 'd', intervalCapMs: 1, formId: null, serverOffsetMs: 0, submissionReason: null, events: [], acknowledgedIds: [], rejectedIds: [] };
    expect(() => AttemptSession.resume({ record: record as never, server: null }, ports)).toThrow('no deadline to resume against');
  });
});
