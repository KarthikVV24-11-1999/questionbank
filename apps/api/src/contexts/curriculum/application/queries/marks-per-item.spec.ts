import { describe, expect, it } from 'vitest';
import { uniformMarksPerItem } from './curriculum-queries.js';

/** What a practice slot is worth (M8-25): what the profile's sections pay for an item, when they all pay the same whole number, and nothing otherwise. */
describe('what an item is worth where it belongs to no section', () => {
  it('is the marks per item every section pays', () => {
    expect(uniformMarksPerItem([{ itemCount: 25, maxMarks: 100 }, { itemCount: 25, maxMarks: 100 }, { itemCount: 20, maxMarks: 80 }])).toBe(4);
    expect(uniformMarksPerItem([{ itemCount: 45, maxMarks: 180 }])).toBe(4);
  });

  it('is nothing where sections pay differently, rather than one section\'s figure or an average', () => {
    expect(uniformMarksPerItem([{ itemCount: 25, maxMarks: 100 }, { itemCount: 25, maxMarks: 75 }])).toBeNull();
  });

  it('is nothing for a fraction of a mark, a section with no items, or no sections', () => {
    expect(uniformMarksPerItem([{ itemCount: 3, maxMarks: 10 }])).toBeNull();
    expect(uniformMarksPerItem([{ itemCount: 0, maxMarks: 10 }])).toBeNull();
    expect(uniformMarksPerItem([{ itemCount: 25, maxMarks: 0 }])).toBeNull();
    expect(uniformMarksPerItem([])).toBeNull();
  });
});
