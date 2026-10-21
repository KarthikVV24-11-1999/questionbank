import { describe, expect, it } from 'vitest';
import { BLUEPRINT_DIFFICULTY_BANDS, BLUEPRINT_ITEM_TYPES } from '../../contexts/assessment/domain/blueprint.js';
import { DIFFICULTY_BANDS, ITEM_TYPES } from '../../contexts/content/public/index.js';

/**
 * Two lists of one vocabulary drift (ENGINEERING-HANDBOOK §5). The assessment
 * domain imports nothing, so it keeps its own copy of the item types and
 * difficulty bands a blueprint can name; this holds the copy to content's own
 * lists, from the one place both contexts may be named together. A type
 * content adds, and a blueprint cannot name, fails here and not in production.
 */
describe('the blueprint vocabulary is content\'s vocabulary', () => {
  it('names exactly the item types content has', () => {
    expect([...BLUEPRINT_ITEM_TYPES].sort()).toEqual([...ITEM_TYPES].sort());
  });

  it('names exactly the difficulty bands content has, in the same order', () => {
    expect([...BLUEPRINT_DIFFICULTY_BANDS]).toEqual([...DIFFICULTY_BANDS]);
  });
});
