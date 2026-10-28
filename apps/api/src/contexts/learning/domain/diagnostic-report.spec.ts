import { describe, expect, it } from 'vitest';
import { findingsOf, fromUnits, type ReportSlot } from './diagnostic-report.js';

const TAX = 't';
const slot = (n: number, concept: string, outcome: string, awarded: string, available: string): ReportSlot => ({ slotRef: `s${n}`, conceptIdentityId: concept, taxonomyVersionId: TAX, outcome, marksAwarded: awarded, marksAvailable: available });

describe('findings are ranked by the marks a concept cost', () => {
  it('ranks four marks lost on one question above two marks lost across three, whatever the counts of wrong answers', () => {
    const findings = findingsOf([
      slot(1, 'hard', 'incorrect', '0', '4'),
      slot(2, 'easy', 'incorrect', '0.5', '1'),
      slot(3, 'easy', 'incorrect', '0.5', '1'),
      slot(4, 'easy', 'incorrect', '0.5', '1'),
      slot(5, 'fine', 'correct', '4', '4'),
    ]);
    expect(findings.map((f) => [f.rank, f.conceptIdentityId, f.marksLost, f.slots])).toEqual([[1, 'hard', '4', 1], [2, 'easy', '1.5', 3]]);
  });

  it('counts a wrong answer under negative marking for the marks it took away as well as the ones it did not earn', () => {
    expect(findingsOf([slot(1, 'c', 'incorrect', '-1', '4')])[0]).toMatchObject({ marksLost: '5', marksAvailable: '4' });
  });

  it('gives a skipped slot its unearned marks to the concept, and says it was skipped (DEC-M7-21)', () => {
    const [finding] = findingsOf([slot(1, 'c', 'unattempted', '0', '4'), slot(2, 'c', 'incorrect', '-1', '4')]);
    expect(finding).toMatchObject({ marksLost: '9', slots: 2, skipped: 1 });
    expect(findingsOf([slot(1, 'avoided', 'unattempted', '0', '4'), slot(2, 'tried', 'incorrect', '-1', '4')]).map((f) => f.conceptIdentityId)).toEqual(['tried', 'avoided']);
  });

  it('leaves out what is not the learner\'s loss: a dropped slot, a bonus, an indeterminate one, and a correct one', () => {
    expect(findingsOf([slot(1, 'c', 'dropped', '0', '0'), slot(2, 'c', 'bonus', '4', '4'), slot(3, 'c', 'indeterminate', '0', '4'), slot(4, 'c', 'correct', '4', '4')])).toEqual([]);
  });

  it('breaks a tie by concept identifier, so the same attempt always gives the same order', () => {
    const slots = [slot(1, 'b', 'incorrect', '0', '4'), slot(2, 'a', 'incorrect', '0', '4'), slot(3, 'c', 'incorrect', '0', '4')];
    const forwards = findingsOf(slots).map((f) => f.conceptIdentityId);
    expect(forwards).toEqual(['a', 'b', 'c']);
    expect(findingsOf([...slots].reverse()).map((f) => f.conceptIdentityId)).toEqual(forwards);
  });

  it('reads marks without a double, and refuses text that is not a mark', () => {
    expect(findingsOf([slot(1, 'c', 'incorrect', '0.1', '0.3')])[0]!.marksLost).toBe('0.2');
    expect(() => findingsOf([slot(1, 'c', 'incorrect', 'NaN', '4')])).toThrow('not a decimal mark');
    expect(fromUnits(-15000n)).toBe('-1.5');
  });
});
