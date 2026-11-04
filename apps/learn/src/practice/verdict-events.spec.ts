import { describe, expect, it } from 'vitest';
import { analyticsRig, expectConforming } from '../testing/analytics-rig.js';
import { createVerdictReporter } from './verdict-events.js';

const FACTS = { timeOnItemMs: 41_000, answerChanges: 2, flagged: true };
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('telling analytics how an answer came out (M8-34, D112)', () => {
  it('says the item was answered, with the outcome the server gave and what the session knows of the answer', async () => {
    const { analytics, sent } = analyticsRig();
    createVerdictReporter(analytics, 'run-1')('s1', '"b"', 'correct', FACTS);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event_name: 'practice.item_answered', payload: { outcome: 'correct', time_on_item_ms: 41_000, answer_changes: 2, was_flagged: true }, context: { attempt_id: 'run-1' } });
    expectConforming(sent);
  });

  it('says it once for an answer, however often the verdict is asked for', async () => {
    const { analytics, sent } = analyticsRig();
    const told = createVerdictReporter(analytics, 'run-1');
    told('s1', '"b"', 'incorrect', FACTS);
    await settle();
    told('s1', '"b"', 'incorrect', FACTS);
    await settle();
    await settle();
    expect(sent).toHaveLength(1);
  });

  it('says it again for a different answer to the same question, and for another question', async () => {
    const { analytics, sent } = analyticsRig();
    const told = createVerdictReporter(analytics, 'run-1');
    told('s1', '"b"', 'incorrect', FACTS);
    await settle();
    told('s1', '"c"', 'correct', FACTS);
    await settle();
    told('s2', '"b"', 'correct', FACTS);
    await settle();
    expect(sent.map((event) => event.payload['outcome'])).toEqual(['incorrect', 'correct', 'correct']);
  });

  it('says nothing of a verdict that is not an outcome', async () => {
    const { analytics, sent } = analyticsRig();
    const told = createVerdictReporter(analytics, 'run-1');
    told('s1', '"b"', 'unattempted', FACTS);
    told('s1', '"b"', 'indeterminate', FACTS);
    await settle();
    expect(sent).toEqual([]);
    // and a word that is not an outcome does not use up the answer's one telling
    told('s1', '"b"', 'correct', FACTS);
    await settle();
    expect(sent).toHaveLength(1);
  });
});
