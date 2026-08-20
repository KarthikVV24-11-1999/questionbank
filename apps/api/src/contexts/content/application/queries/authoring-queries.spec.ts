import { describe, expect, it } from 'vitest';
import { expectValue } from '../../../../testing/expect-result.js';
import { itemVersionProps, PROVENANCE_CONTEXT } from '../../../../testing/content-fixtures.js';
import { createItemVersion } from '../../domain/item-version.js';
import { createItem, reconstituteItem } from '../../domain/item.js';
import { toAuthoringItemView, toAuthoringVersionView } from './authoring-queries.js';

function version() {
  return expectValue(createItemVersion(itemVersionProps(), PROVENANCE_CONTEXT));
}

describe('toAuthoringItemView', () => {
  it('omits stateEnteredAt when the aggregate does not carry one — M3’s own shape', () => {
    const item = expectValue(
      createItem({ itemId: 'item-1', itemType: 'SINGLE_CORRECT_MCQ', initialVersion: version() }),
    );
    expect(Object.hasOwn(toAuthoringItemView(item), 'stateEnteredAt')).toBe(false);
  });

  it('carries stateEnteredAt through when the aggregate has one', () => {
    const item = expectValue(
      reconstituteItem({
        itemId: 'item-1',
        itemType: 'SINGLE_CORRECT_MCQ',
        lifecycleState: 'draft',
        versions: [version()],
        aggregateVersion: 1,
        stateEnteredAt: '2026-08-19T09:00:00Z',
      }),
    );
    expect(toAuthoringItemView(item).stateEnteredAt).toBe('2026-08-19T09:00:00Z');
  });

  it('carries currentPublishedVersionId only when the item has one', () => {
    const draft = expectValue(
      createItem({ itemId: 'item-1', itemType: 'SINGLE_CORRECT_MCQ', initialVersion: version() }),
    );
    expect(Object.hasOwn(toAuthoringItemView(draft), 'currentPublishedVersionId')).toBe(false);
  });
});

describe('toAuthoringVersionView', () => {
  it('omits stimulusVersionRef when the version does not pin one', () => {
    expect(Object.hasOwn(toAuthoringVersionView(version()), 'stimulusVersionRef')).toBe(false);
  });
});
