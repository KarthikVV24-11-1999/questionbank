import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../../../platform/config/config.js';
import { InMemoryAttempts, InMemoryContent, StubCorpus, StubPins, aSigner } from '../../../testing/assessment-fakes.js';
import { TAG, id } from '../../../testing/assessment-fixtures.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import type { AssemblyCandidate } from '../domain/assembly.js';
import { buildPracticePackage } from '../domain/form-package.js';
import { verifyPackage } from '../infrastructure/package-signer.js';
import { CreatePracticeAttemptHandler, GrowPracticeAttemptHandler, type PracticeDependencies } from './handlers/practice-handlers.js';
import { GetPracticePackageHandler } from './handlers/package-handler.js';
import type { ApplicationContext } from './ports.js';

const NOW = new Date('2026-11-04T09:00:00.000Z');
const learner = (n = 1): ApplicationContext => ({ principal: { kind: 'human', id: id(TAG.student, n), roleContext: ['learner'] }, correlationId: 'c' });
const cand = (n: number): AssemblyCandidate => ({
  itemId: id(TAG.item, n), itemVersionId: id(TAG.itemVersion, n), itemType: 'SINGLE_CORRECT_MCQ', difficultyBand: 'moderate',
  conceptIdentityIds: [id(0xc0, n)], stimulusVersionId: n === 2 ? id(TAG.stimulus, 1) : null, isPublished: true, isAnchor: false, anchorExposureCap: null,
});

function rig() {
  const attempts = new InMemoryAttempts();
  const content = new InMemoryContent();
  for (let n = 1; n <= 6; n += 1) content.items.set(id(TAG.itemVersion, n), { itemVersionId: id(TAG.itemVersion, n), stem: `q${n}` });
  content.stimuli.set(id(TAG.stimulus, 1), { stimulusVersionId: id(TAG.stimulus, 1), body: 'passage' });
  let n = 0;
  const deps: PracticeDependencies = {
    attempts, corpus: new StubCorpus({ candidates: [1, 2, 3, 4, 5, 6].map(cand), exposure: new Map(), nearDuplicates: new Map(), unevaluated: [] }), practicePins: new StubPins(),
    intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS, clock: { now: () => NOW }, identifiers: { next: () => id(0xd0, (n += 1)) }, audit: { record: async () => undefined },
  };
  return { attempts, content, deps, handler: new GetPracticePackageHandler({ attempts, content, signer: aSigner() }) };
}
const run = async (r: ReturnType<typeof rig>, count = 3) => expectValue(await new CreatePracticeAttemptHandler(r.deps).handle({ examProfileVersionId: id(TAG.profile), selectionStrategy: 'filtered', scopeFilter: { subject: 'physics' }, count, idempotencyKey: `k${count}` } as never, learner())).attempt.attemptId;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('the package of a practice run (M8-23, D87)', () => {
  it('carries the questions of the run, in the order of its slots, signed with the key a form is signed with', async () => {
    const r = rig();
    const attemptId = await run(r);
    const built = expectValue(await r.handler.handle({ attemptId }, learner()));
    const document = JSON.parse(text(built.bytes)) as { format: string; run: { attemptId: string }; slots: Array<{ slotId: string; ordinal: number; itemVersionId: string }>; stimuli: unknown[] };
    expect(document).toMatchObject({ format: 'questionbank.practice-package', run: { attemptId } });
    expect(document.slots.map((slot) => slot.ordinal)).toEqual([1, 2, 3]);
    expect(document.slots.map((slot) => slot.slotId)).toEqual(r.attempts.stored.get(attemptId)!.slots.map((slot) => slot.slotId));
    expect(built.slotIds).toEqual(document.slots.map((slot) => slot.slotId));
    expect(verifyPackage(built.bytes, built.signature, aSigner().publicKey)).toBe(true);
    expect(built.keyId).toBe(aSigner().keyId);
    expect(built.digest).toBe(aSigner().sign(built.bytes).digest);
  });

  it('is byte-identical for the same run in the same state', async () => {
    const r = rig();
    const attemptId = await run(r);
    const [a, b] = [expectValue(await r.handler.handle({ attemptId }, learner())), expectValue(await r.handler.handle({ attemptId }, learner()))];
    expect(text(a.bytes)).toBe(text(b.bytes));
    expect(a.digest).toBe(b.digest);
  });

  it('is the owner\'s alone: another learner asking, and a run that does not exist, are the same refusal with no bytes', async () => {
    const r = rig();
    const attemptId = await run(r);
    const other = await r.handler.handle({ attemptId }, learner(2));
    const missing = await r.handler.handle({ attemptId: id(TAG.attempt, 99) }, learner());
    expect(expectError(other)).toMatchObject({ kind: 'NotFound', code: 'NOT_FOUND' });
    expect(expectError(missing)).toMatchObject({ kind: 'NotFound', code: 'NOT_FOUND' });
    expect(JSON.stringify(other)).not.toContain('questionbank.practice-package');
    expect(r.content.asked).toEqual([]);
  });

  it('is for a learner and for no one else', async () => {
    const r = rig();
    const attemptId = await run(r);
    for (const role of ['content_ops', 'system', 'guest', 'author']) {
      const asked = await r.handler.handle({ attemptId }, { principal: { kind: 'human', id: id(TAG.student, 1), roleContext: [role] }, correlationId: 'c' });
      expect(expectError(asked).kind, role).toBe('Authorization');
    }
  });

  it('is never unsigned: with no signing key it is not served at all, and nothing is read', async () => {
    const r = rig();
    const attemptId = await run(r);
    const unsigned = new GetPracticePackageHandler({ attempts: r.attempts, content: r.content, signer: undefined });
    expect(expectError(await unsigned.handle({ attemptId }, learner())).code).toBe('PACKAGE_SIGNING_UNAVAILABLE');
    expect(r.content.asked).toEqual([]);
  });

  it('is for a practice run: a mock is fetched by its form', async () => {
    const r = rig();
    const attemptId = await run(r);
    r.attempts.stored.set(attemptId, { ...r.attempts.stored.get(attemptId)!, mode: 'mock' });
    expect(expectError(await r.handler.handle({ attemptId }, learner())).code).toBe('ATTEMPT_NOT_PRACTICE');
  });

  it('reads each pinned version once, and the stimulus of the one item that has one', async () => {
    const r = rig();
    const attemptId = await run(r, 3);
    await r.handler.handle({ attemptId }, learner());
    expect(r.content.asked.filter((q) => q.startsWith('item '))).toHaveLength(3);
    expect(r.content.asked.filter((q) => q.startsWith('stimulus '))).toEqual([`stimulus ${id(TAG.stimulus, 1)}`]);
  });

  it('reads a stimulus two slots share once', async () => {
    const r = rig();
    const attemptId = await run(r, 3);
    const stored = r.attempts.stored.get(attemptId)!;
    r.attempts.stored.set(attemptId, { ...stored, slots: stored.slots.map((slot) => ({ ...slot, stimulusVersionId: id(TAG.stimulus, 1) })) });
    await r.handler.handle({ attemptId }, learner());
    expect(r.content.asked.filter((q) => q.startsWith('stimulus '))).toEqual([`stimulus ${id(TAG.stimulus, 1)}`]);
  });

  it('is a different package when the run grows, with the first slots unchanged and the digest changed', async () => {
    const r = rig();
    const attemptId = await run(r, 2);
    const before = expectValue(await r.handler.handle({ attemptId }, learner()));
    expectValue(await new GrowPracticeAttemptHandler(r.deps).handle({ attemptId, count: 2 } as never, learner()));
    const after = expectValue(await r.handler.handle({ attemptId }, learner()));
    expect(after.digest).not.toBe(before.digest);
    expect(after.slotIds).toHaveLength(4);
    expect(after.slotIds.slice(0, 2)).toEqual(before.slotIds);
  });

  it('refuses content that disagrees with what a slot pinned, rather than serve another version', async () => {
    const r = rig();
    const attemptId = await run(r, 1);
    const pinned = r.attempts.stored.get(attemptId)!.slots[0]!.itemVersionId;
    r.content.items.set(pinned, { itemVersionId: id(TAG.itemVersion, 6), stem: 'another' });
    expect(expectError(await r.handler.handle({ attemptId }, learner())).code).toBe('PACKAGE_VIEW_DISAGREES_WITH_PIN');
  });

  it('says what content said when a version cannot be read', async () => {
    const r = rig();
    const attemptId = await run(r, 1);
    r.content.failWith = { kind: 'Unavailable', code: 'CONTENT_DOWN', message: 'down' };
    expect(expectError(await r.handler.handle({ attemptId }, learner())).code).toBe('CONTENT_DOWN');
  });

  it('says nothing of marks, of an anchor or of a key', async () => {
    const r = rig();
    const attemptId = await run(r);
    const bytes = text(expectValue(await r.handler.handle({ attemptId }, learner())).bytes);
    expect(bytes).not.toMatch(/marksAvailable|isAnchor|answerKey|correctOption/u);
  });
});

describe('the package builder, apart from the handler', () => {
  async function built() {
    const r = rig();
    const attemptId = await run(r, 3);
    const attempt = r.attempts.stored.get(attemptId)!;
    const items = new Map(attempt.slots.map((slot) => [slot.itemVersionId, { itemVersionId: slot.itemVersionId, stem: 'q' }]));
    const stimuli = new Map<string, { stimulusVersionId: string; body: string }>(attempt.slots.flatMap((slot) => (slot.stimulusVersionId === null ? [] : [[slot.stimulusVersionId, { stimulusVersionId: slot.stimulusVersionId, body: 'p' }] as const])));
    return { attempt, items, stimuli };
  }

  it('lists slots in the order of their ordinals however the run holds them', async () => {
    const { attempt, items, stimuli } = await built();
    const shuffled = { ...attempt, slots: [attempt.slots[2]!, attempt.slots[0]!, attempt.slots[1]!] };
    expect(expectValue(buildPracticePackage(shuffled, { items, stimuli })).slotIds).toEqual(attempt.slots.map((slot) => slot.slotId));
  });

  it('refuses content for an item version or a stimulus the run did not pin', async () => {
    const { attempt, items, stimuli } = await built();
    const strayItem = new Map([...items, [id(TAG.itemVersion, 5), { itemVersionId: id(TAG.itemVersion, 5), stem: 'x' }] as const]);
    expect(expectError(buildPracticePackage(attempt, { items: strayItem, stimuli })).code).toBe('PACKAGE_CONTENT_NOT_PINNED');
    const strayStimulus = new Map([...stimuli, [id(TAG.stimulus, 9), { stimulusVersionId: id(TAG.stimulus, 9), body: 'x' }] as [string, { stimulusVersionId: string; body: string }]]);
    expect(expectError(buildPracticePackage(attempt, { items, stimuli: strayStimulus })).code).toBe('PACKAGE_CONTENT_NOT_PINNED');
  });
});
