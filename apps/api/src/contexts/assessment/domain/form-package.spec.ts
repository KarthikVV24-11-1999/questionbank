import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { TAG, WINDOW, aClosedForm, aDraftForm, aPublishedForm, aScheduledForm, anActiveForm, id } from '../../../testing/assessment-fixtures.js';
import { buildFormPackage, canonicalJson, type JsonValue, type PackageContent } from './form-package.js';
import { slotsOf } from './form.js';

const view = (n: number): JsonValue => ({ itemVersionId: id(TAG.itemVersion, n), itemId: id(TAG.item, n), stem: `question ${n}`, options: [{ optionId: 'a' }, { optionId: 'b' }] });
const stimulusView = (n: number): JsonValue => ({ stimulusVersionId: id(TAG.stimulus, n), body: `passage ${n}` });

/** Content for every slot of a form, as the caller would gather it from the form's pins. */
function contentFor(form = anActiveForm()): { items: Map<string, JsonValue>; stimuli: Map<string, JsonValue> } & PackageContent {
  const slots = slotsOf(form);
  return {
    items: new Map(slots.map((slot) => [slot.itemVersionId, view(Number(slot.itemVersionId.slice(-12)))])),
    stimuli: new Map(slots.flatMap((slot) => (slot.stimulusVersionId === null ? [] : [[slot.stimulusVersionId, stimulusView(1)] as const]))),
  };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const parsed = (bytes: Uint8Array) => JSON.parse(text(bytes)) as { form: Record<string, unknown>; sections: { slots: { slotId: string; item: unknown; marksAvailable: number }[] }[]; stimuli: unknown[] };

describe('building a package from an active form', () => {
  it('is byte-identical for the same form, twice — and for the same content handed over in another order', () => {
    const form = anActiveForm();
    const first = expectValue(buildFormPackage(form, contentFor(form)));
    const second = expectValue(buildFormPackage(form, contentFor(form)));
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    const content = contentFor(form);
    const reordered = { items: new Map([...content.items].reverse()), stimuli: new Map([...content.stimuli].reverse()) };
    expect(Buffer.from(expectValue(buildFormPackage(form, reordered)).bytes).equals(Buffer.from(first.bytes))).toBe(true);
  });

  it('has every slot of the form exactly once, in form order', () => {
    const form = anActiveForm();
    const built = expectValue(buildFormPackage(form, contentFor(form)));
    const document = parsed(built.bytes);
    const inPackage = document.sections.flatMap((section) => section.slots.map((slot) => slot.slotId));
    expect(inPackage).toEqual(slotsOf(form).map((slot) => slot.slotId));
    expect(new Set(inPackage).size).toBe(6);
    expect(built.slotIds).toEqual(inPackage);
  });

  it('carries the form\'s identity, sessions and window, and each slot\'s marks and pinned item view', () => {
    const form = anActiveForm({ sessionRefs: ['shift-1', 'shift-2'] });
    const document = parsed(expectValue(buildFormPackage(form, contentFor(form))).bytes);
    expect(document.form).toEqual({
      formId: form.formId,
      examProfileVersionId: form.examProfileVersionId,
      formType: 'mock',
      sessionRefs: ['shift-1', 'shift-2'],
      publishedAt: form.publishedAt,
      window: { opensAt: WINDOW.opensAt, closesAt: WINDOW.closesAt },
    });
    expect(document.sections[0]!.slots[0]!.marksAvailable).toBe(4);
    expect(document.sections[0]!.slots[0]!.item).toEqual(view(1));
    expect(document.stimuli).toEqual([{ stimulusVersionId: id(TAG.stimulus, 1), view: stimulusView(1) }]);
  });

  it('says nothing a student has no business knowing: no anchor flag, no blueprint report', () => {
    const form = anActiveForm();
    const bytes = text(expectValue(buildFormPackage(form, contentFor(form))).bytes);
    for (const word of ['isAnchor', 'blueprintConformance', 'satisfied', 'markingRuleSet']) expect(bytes, word).not.toContain(word);
  });

  it('is frozen, and shares no storage with the caller\'s content', () => {
    const form = anActiveForm();
    const content = contentFor(form);
    const built = expectValue(buildFormPackage(form, content));
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.slotIds)).toBe(true);
  });
});

describe('what it refuses', () => {
  it('builds from an active form only, and says what state it found', () => {
    for (const form of [aDraftForm(), aPublishedForm(), aScheduledForm(), aClosedForm()]) {
      const error = expectError(buildFormPackage(form, contentFor(form)));
      expect(error.code, form.state).toBe('PACKAGE_FORM_NOT_ACTIVE');
      expect(error.message).toContain(form.state);
      expect(error.kind).toBe('PreconditionFailed');
    }
  });

  it('refuses a slot with no content, and a stimulus with none', () => {
    const form = anActiveForm();
    const noItem = contentFor(form);
    noItem.items.delete(id(TAG.itemVersion, 3));
    expect(expectError(buildFormPackage(form, noItem)).code).toBe('PACKAGE_ITEM_MISSING');
    const noStimulus = contentFor(form);
    noStimulus.stimuli.clear();
    expect(expectError(buildFormPackage(form, noStimulus)).code).toBe('PACKAGE_STIMULUS_MISSING');
  });

  it('refuses content the form did not pin: a package that carried more could drift from what the attempt was pinned to', () => {
    const form = anActiveForm();
    const extraItem = contentFor(form);
    extraItem.items.set(id(TAG.itemVersion, 99), view(99));
    expect(expectError(buildFormPackage(form, extraItem)).code).toBe('PACKAGE_CONTENT_NOT_PINNED');
    const extraStimulus = contentFor(form);
    extraStimulus.stimuli.set(id(TAG.stimulus, 99), stimulusView(99));
    expect(expectError(buildFormPackage(form, extraStimulus)).code).toBe('PACKAGE_CONTENT_NOT_PINNED');
  });

  it('refuses a view that is for another version than the one it was filed under — a package that resolved afresh', () => {
    const form = anActiveForm();
    const swapped = contentFor(form);
    swapped.items.set(id(TAG.itemVersion, 2), view(2000)); // a newer version of item 2, filed under the pinned id
    expect(expectError(buildFormPackage(form, swapped)).code).toBe('PACKAGE_VIEW_DISAGREES_WITH_PIN');
    const notAnObject = contentFor(form);
    notAnObject.items.set(id(TAG.itemVersion, 2), 'text');
    expect(expectError(buildFormPackage(form, notAnObject)).code).toBe('PACKAGE_VIEW_DISAGREES_WITH_PIN');
    const array = contentFor(form);
    array.items.set(id(TAG.itemVersion, 2), []);
    expect(expectError(buildFormPackage(form, array)).code).toBe('PACKAGE_VIEW_DISAGREES_WITH_PIN');
    const numeric = contentFor(form);
    numeric.items.set(id(TAG.itemVersion, 2), { itemVersionId: 5 });
    expect(expectError(buildFormPackage(form, numeric)).code).toBe('PACKAGE_VIEW_DISAGREES_WITH_PIN');
  });
});

describe('canonicalJson', () => {
  it('writes every object\'s keys in sorted order, recursively, so equal values are equal text', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('leaves arrays in order and scalars as they are', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect([canonicalJson('x'), canonicalJson(5), canonicalJson(true), canonicalJson(null)]).toEqual(['"x"', '5', 'true', 'null']);
  });
});
