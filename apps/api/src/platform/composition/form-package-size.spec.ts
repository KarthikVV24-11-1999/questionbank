import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { expectValue } from '../../testing/expect-result.js';
import { formProps } from '../../testing/assessment-fixtures.js';
import { FOUR_OPTIONS, PROVENANCE_CONTEXT, itemOption, itemVersionProps, numericSpec } from '../../testing/content-fixtures.js';
import { createContentBody, type Block, type ContentBody } from '../../contexts/content/domain/content-body.js';
import { createItemVersion } from '../../contexts/content/domain/item-version.js';
import { toDeliveryItemView } from '../../contexts/content/application/queries/delivery-queries.js';
import { buildFormPackage, type JsonValue } from '../../contexts/assessment/domain/form-package.js';
import { createForm, openForm, publishForm, scheduleForm, slotsOf } from '../../contexts/assessment/domain/form.js';

/**
 * M6-27 — the size budget: a signed package for a full-length form is at most 3 MB,
 * measured here over the bytes the route serves.
 *
 * **What is measured, and what is not.** The package carries each item's delivery
 * view and each stimulus once. Media is carried *by reference* (an asset version
 * id, as the content body's own model says), so the images a question shows are
 * separate downloads and are **not** in this figure; neither is the CDN that
 * serves the package, which cannot be measured without a deployment. The budget
 * this proves is the package itself.
 *
 * The form is 75 items — a JEE Main paper's length — over three sections, with
 * the mix an exam has (mostly single-answer, some multiple, matching and numeric),
 * stems of a realistic length with display mathematics, a stimulus on one slot in
 * five, and media references on a third of the stems. Generated deterministically,
 * so the figure is reproducible. A second form with every text ten times longer
 * shows the headroom, so a pass is not a pass by a hair.
 */
const BUDGET_BYTES = 3 * 1024 * 1024;
const ITEM_COUNT = 75;

const LATEX = String.raw`\frac{d^{2}x}{dt^{2}} + \omega^{2}x = \frac{F_{0}}{m}\cos(\omega_{d}t), \quad \omega = \sqrt{\frac{k}{m}}`;
const sentence = (n: number, repeat: number) =>
  `${'A uniform rod of mass M and length L is hinged at one end and released from rest in a horizontal position; find the angular acceleration at the instant of release and the reaction at the hinge. '.repeat(repeat)}(variant ${n})`;

function body(n: number, repeat: number, withMedia: boolean): ContentBody {
  const blocks: Block[] = [
    { kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: sentence(n, repeat), marks: [] }, { kind: 'MATH_INLINE', latex: String.raw`I = \tfrac{1}{3}ML^{2}`, textAlternative: 'I equals one third M L squared' }] },
    { kind: 'MATH_BLOCK', latex: LATEX, textAlternative: 'the second derivative of x plus omega squared x equals F naught over m times cosine of omega d t' },
    ...(withMedia ? [{ kind: 'MEDIA_BLOCK' as const, assetVersionId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, sizeHint: 'HALF_WIDTH' as const }] : []),
  ];
  return expectValue(createContentBody(blocks));
}

const option = (id: string, ordinal: number, n: number, repeat: number) => ({ ...itemOption(id, ordinal), body: body(n * 10 + ordinal, repeat, false) });

function specFor(n: number, repeat: number) {
  const kind = n % 15;
  const options = ['a', 'b', 'c', 'd'].map((id, index) => option(id, index + 1, n, repeat));
  if (kind === 1) return { itemType: 'MULTIPLE_CORRECT_MCQ' as const, options, correctOptionIds: ['a', 'c'] };
  if (kind === 2) {
    const member = (id: string, ordinal: number) => ({ memberId: id, ordinal, body: body(n * 10 + ordinal, repeat, false) });
    return {
      itemType: 'MATCHING' as const,
      left: [member('l1', 1), member('l2', 2), member('l3', 3), member('l4', 4)],
      right: [member('r1', 1), member('r2', 2), member('r3', 3), member('r4', 4)],
      pairs: [{ left: 'l1', right: 'r2' }, { left: 'l2', right: 'r1' }, { left: 'l3', right: 'r4' }, { left: 'l4', right: 'r3' }],
    };
  }
  if (kind === 3 || kind === 4) return numericSpec();
  return { itemType: 'SINGLE_CORRECT_MCQ' as const, options, correctOptionId: 'b' };
}

/** A published-then-active 75-slot form and the delivery views of everything it pins. */
function fullForm(repeat: number) {
  const slots = Array.from({ length: ITEM_COUNT }, (_, index) => ({
    slotId: `00000000-0000-4000-8000-${String(1000 + index).padStart(12, '0')}`,
    ordinal: index + 1,
    itemId: `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`,
    itemVersionId: `00000000-0000-4000-a000-${String(index).padStart(12, '0')}`,
    stimulusVersionId: index % 5 === 0 ? `00000000-0000-4000-b000-${String(index % 15).padStart(12, '0')}` : null,
    marksAvailable: 4,
    isAnchor: index < 12,
  }));
  const draft = expectValue(
    createForm(
      formProps({
        blueprintConformance: { satisfied: true, sections: 3 },
        sections: [0, 1, 2].map((section) => ({ ordinal: section + 1, sectionSpecRef: `section-${section + 1}`, slots: slots.slice(section * 25, section * 25 + 25) })),
      }),
    ),
  );
  const anchors = new Set(slotsOf(draft).filter((slot) => slot.isAnchor).map((slot) => slot.itemVersionId));
  const active = expectValue(
    openForm(
      expectValue(scheduleForm(expectValue(publishForm(draft, '2026-10-21T07:00:00.000Z', anchors)), { opensAt: '2026-10-21T08:00:00.000Z', closesAt: '2026-10-21T12:00:00.000Z' }, '2026-10-21T07:30:00.000Z')),
      '2026-10-21T09:00:00.000Z',
    ),
  );

  const items = new Map<string, JsonValue>();
  slots.forEach((slot, index) => {
    const version = expectValue(
      createItemVersion(
        itemVersionProps({
          versionId: slot.itemVersionId,
          itemType: specFor(index, repeat).itemType,
          stem: body(index, repeat, index % 3 === 0),
          responseSpec: specFor(index, repeat),
          ...(slot.stimulusVersionId === null ? {} : { stimulusVersionRef: slot.stimulusVersionId }),
        }),
        PROVENANCE_CONTEXT,
      ),
    );
    items.set(slot.itemVersionId, toDeliveryItemView(slot.itemId, version) as unknown as JsonValue);
  });
  const stimuli = new Map<string, JsonValue>();
  for (const slot of slots) {
    if (slot.stimulusVersionId === null || stimuli.has(slot.stimulusVersionId)) continue;
    stimuli.set(slot.stimulusVersionId, {
      stimulusId: slot.stimulusVersionId,
      stimulusVersionId: slot.stimulusVersionId,
      versionNo: 1,
      stimulusType: 'passage',
      body: body(900, repeat * 4, true) as unknown as JsonValue,
    });
  }
  return { active, items, stimuli, slots };
}

const measure = (repeat: number) => {
  const { active, items, stimuli } = fullForm(repeat);
  const built = expectValue(buildFormPackage(active, { items, stimuli }));
  return { raw: built.bytes.length, gzip: gzipSync(built.bytes).length, slots: built.slotIds.length, stimuli: stimuli.size };
};

describe('M6-27 — the package size budget', () => {
  it('is a full-length form: 75 items over three sections, with all four item types and shared stimuli', () => {
    const { items, slots } = fullForm(1);
    expect(slots).toHaveLength(75);
    expect(new Set([...items.values()].map((view) => (view as { itemType: string }).itemType))).toEqual(new Set(['SINGLE_CORRECT_MCQ', 'MULTIPLE_CORRECT_MCQ', 'MATCHING', 'NUMERIC']));
  });

  it('is at most 3 MB for a realistic 75-item form, and the figure is stated', () => {
    const { raw, gzip, slots, stimuli } = measure(1);
    // gzip is reported, not asserted against a budget: this generated text repeats itself, so it compresses far better than real prose would.
    // eslint-disable-next-line no-console
    console.log(`M6-27 package size: ${slots} items, ${stimuli} stimuli — ${raw} bytes (${(raw / 1024).toFixed(1)} KiB) raw, ${gzip} bytes (${(gzip / 1024).toFixed(1)} KiB) gzip`);
    expect(slots).toBe(75);
    expect(raw).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(gzip).toBeLessThan(raw);
  });

  it('still fits with every text ten times longer: the pass is not a pass by a hair', () => {
    const heavy = measure(10);
    // eslint-disable-next-line no-console
    console.log(`M6-27 package size at ten times the text: ${heavy.raw} bytes (${(heavy.raw / 1024).toFixed(1)} KiB) raw, ${heavy.gzip} bytes gzip`);
    expect(heavy.raw).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(heavy.raw).toBeGreaterThan(measure(1).raw);
  });

  it('is able to fail: a form whose text is large enough is over budget', () => {
    expect(measure(400).raw).toBeGreaterThan(BUDGET_BYTES);
  });
});
