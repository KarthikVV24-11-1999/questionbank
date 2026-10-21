import { describe, expect, it } from 'vitest';
import { expectValue } from '../../testing/expect-result.js';
import { anActiveForm } from '../../testing/assessment-fixtures.js';
import { FOUR_OPTIONS, PROVENANCE_CONTEXT, itemOption, itemVersionProps, numericSpec, textBody } from '../../testing/content-fixtures.js';
import { createItemVersion, type ItemVersion } from '../../contexts/content/domain/item-version.js';
import { KEY_BEARING_FIELDS } from '../../fitness/content-rules.js';
import { toAuthoringVersionView } from '../../contexts/content/application/queries/authoring-queries.js';
import { toDeliveryItemView } from '../../contexts/content/application/queries/delivery-queries.js';
import { buildFormPackage, type JsonValue } from '../../contexts/assessment/domain/form-package.js';
import { slotsOf } from '../../contexts/assessment/domain/form.js';

/**
 * M6-25 — the form package carries no answer key, proven over its bytes.
 *
 * The scan reads the package as the device receives it, not the code that made
 * it: a delivery view that is key-free by construction says nothing about the
 * bytes if a later change spreads a whole specification into one. And a scan is
 * only worth anything if it can find a key where one exists, so each case runs
 * the *same* scan over the same items' authoring views and requires it to hit.
 *
 * What a key is, by item type. A correct *option id* is indistinguishable from
 * any other option id by value, so for the choice types the key is found by the
 * field that names it; a matching key is the pairing; a numeric key has values
 * (an expected value and a tolerance) chosen to appear nowhere a view would
 * legitimately put them, so they are found by value too.
 */
const KEY_FIELD_NAMES: readonly string[] = [...KEY_BEARING_FIELDS, 'pairs'];
const EXPECTED_VALUE = '9.813721';
const TOLERANCE_VALUE = '0.004217';
const KEY_VALUES = [EXPECTED_VALUE, TOLERANCE_VALUE];

const member = (memberId: string, ordinal: number) => ({ memberId, ordinal, body: textBody(`member ${memberId}`) });

const VERSION_PROPS = {
  SINGLE_CORRECT_MCQ: { itemType: 'SINGLE_CORRECT_MCQ' as const, responseSpec: { itemType: 'SINGLE_CORRECT_MCQ' as const, options: FOUR_OPTIONS, correctOptionId: 'b' } },
  MULTIPLE_CORRECT_MCQ: {
    itemType: 'MULTIPLE_CORRECT_MCQ' as const,
    responseSpec: { itemType: 'MULTIPLE_CORRECT_MCQ' as const, options: [itemOption('a', 1), itemOption('b', 2), itemOption('c', 3)], correctOptionIds: ['a', 'c'] },
  },
  MATCHING: {
    itemType: 'MATCHING' as const,
    responseSpec: {
      itemType: 'MATCHING' as const,
      left: [member('l1', 1), member('l2', 2)],
      right: [member('r1', 1), member('r2', 2)],
      pairs: [
        { left: 'l1', right: 'r2' },
        { left: 'l2', right: 'r1' },
      ],
    },
  },
  NUMERIC: { itemType: 'NUMERIC' as const, responseSpec: numericSpec({ expectedValue: EXPECTED_VALUE, toleranceValue: TOLERANCE_VALUE }) },
};
const ITEM_TYPES = Object.keys(VERSION_PROPS) as (keyof typeof VERSION_PROPS)[];

const versionFor = (type: keyof typeof VERSION_PROPS, versionId: string): ItemVersion =>
  expectValue(createItemVersion(itemVersionProps({ versionId, ...VERSION_PROPS[type] }), PROVENANCE_CONTEXT));

const bytesOf = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');

/** Every way the scan can find a key in `bytes`: a key-naming field, or a key value. */
function keyFindings(bytes: Buffer): string[] {
  return [
    ...KEY_FIELD_NAMES.filter((name) => bytes.includes(Buffer.from(`"${name}":`, 'utf8'))).map((name) => `field ${name}`),
    ...KEY_VALUES.filter((value) => bytes.includes(Buffer.from(value, 'utf8'))).map((value) => `value ${value}`),
  ];
}

describe('M6-25 — the package is key-free, by a scan of its bytes', () => {
  const form = anActiveForm();
  const slots = slotsOf(form);
  const typeOfSlot = (index: number): keyof typeof VERSION_PROPS => ITEM_TYPES[index % ITEM_TYPES.length]!;
  const versions = slots.map((slot, index) => versionFor(typeOfSlot(index), slot.itemVersionId));

  const delivery = new Map<string, JsonValue>(versions.map((version, index) => [version.versionId, toDeliveryItemView(`item-${index}`, version) as unknown as JsonValue]));
  const stimuli = new Map<string, JsonValue>(
    slots.flatMap((slot) => (slot.stimulusVersionId === null ? [] : [[slot.stimulusVersionId, { stimulusVersionId: slot.stimulusVersionId, body: 'a passage' }] as [string, JsonValue]])),
  );
  const packageBytes = Buffer.from(expectValue(buildFormPackage(form, { items: delivery, stimuli })).bytes);

  it('covers all four item types, so the proof is not over a convenient subset', () => {
    expect(new Set(versions.map((version) => version.itemType))).toEqual(new Set(['SINGLE_CORRECT_MCQ', 'MULTIPLE_CORRECT_MCQ', 'MATCHING', 'NUMERIC']));
    expect(ITEM_TYPES).toHaveLength(4);
  });

  it('finds no key field and no key value anywhere in the package bytes', () => {
    expect(keyFindings(packageBytes)).toEqual([]);
  });

  for (const type of ITEM_TYPES) {
    it(`is not vacuous for ${type}: the same scan finds the key in that item's authoring view`, () => {
      const version = versionFor(type, 'authoring-view-version');
      const authoring = keyFindings(bytesOf(toAuthoringVersionView(version)));
      expect(authoring.length).toBeGreaterThan(0);
      // And the delivery view of that very item is clean.
      expect(keyFindings(bytesOf(toDeliveryItemView('item', version)))).toEqual([]);
    });
  }

  it('finds the specific thing each type keeps: the field for a choice, the pairing for matching, the values for numeric', () => {
    const found = (type: keyof typeof VERSION_PROPS) => keyFindings(bytesOf(toAuthoringVersionView(versionFor(type, 'v'))));
    expect(found('SINGLE_CORRECT_MCQ')).toContain('field correctOptionId');
    expect(found('MULTIPLE_CORRECT_MCQ')).toContain('field correctOptionIds');
    expect(found('MATCHING')).toContain('field pairs');
    expect(found('NUMERIC')).toEqual(expect.arrayContaining([`value ${EXPECTED_VALUE}`, `value ${TOLERANCE_VALUE}`]));
  });

  it('finds a key planted in the package itself — a spread of a whole specification into a delivery view', () => {
    const leaky = new Map(delivery);
    const first = slots[0]!.itemVersionId;
    leaky.set(first, { ...(delivery.get(first) as { [key: string]: JsonValue }), ...(toAuthoringVersionView(versions[0]!).responseSpec as unknown as { [key: string]: JsonValue }) });
    const planted = Buffer.from(expectValue(buildFormPackage(form, { items: leaky, stimuli })).bytes);
    expect(keyFindings(planted)).toContain('field correctOptionId');
  });

  it('finds a numeric key value planted into a view, which no field name would give away', () => {
    const leaky = new Map(delivery);
    const numericSlot = slots[3]!.itemVersionId;
    leaky.set(numericSlot, { ...(delivery.get(numericSlot) as { [key: string]: JsonValue }), hint: `about ${EXPECTED_VALUE}` });
    const planted = Buffer.from(expectValue(buildFormPackage(form, { items: leaky, stimuli })).bytes);
    expect(keyFindings(planted)).toContain(`value ${EXPECTED_VALUE}`);
  });
});
