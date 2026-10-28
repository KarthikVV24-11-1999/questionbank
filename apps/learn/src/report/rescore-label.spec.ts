import { describe, expect, it } from 'vitest';
import { rescoreLabel } from './rescore-label.js';

describe('whether a report says the paper was re-scored (D84)', () => {
  it('says the report is of a replaced score when the record that stands is not the one it is labelled with', () => {
    expect(rescoreLabel({ scoreRecordId: 'a' }, { scoreRecordId: 'b', generation: 2 })).toEqual({ kind: 'replaced', generation: 2 });
  });

  it('says the paper was re-scored when the report is of the record that stands and that record is past the first', () => {
    expect(rescoreLabel({ scoreRecordId: 'b' }, { scoreRecordId: 'b', generation: 2 })).toEqual({ kind: 'rescored', generation: 2 });
  });

  it('says nothing of a first score that stands, or where the standing score could not be read', () => {
    expect(rescoreLabel({ scoreRecordId: 'a' }, { scoreRecordId: 'a', generation: 1 })).toEqual({ kind: 'none' });
    expect(rescoreLabel({ scoreRecordId: 'a' }, null)).toEqual({ kind: 'none' });
  });
});
