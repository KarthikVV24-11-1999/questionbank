import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { InMemoryContent, InMemoryForms, TEST_SIGNING_SEED, aSigner } from '../../../testing/assessment-fakes.js';
import { TAG, aPublishedForm, anActiveForm, id } from '../../../testing/assessment-fixtures.js';
import { verifyPackage } from '../infrastructure/package-signer.js';
import { GetFormPackageHandler, GetPackageSigningKeyHandler } from './handlers/package-handler.js';
import type { ApplicationContext } from './ports.js';

const ctx = (role: string): ApplicationContext => ({ principal: { kind: 'human', id: id(TAG.student, 9), roleContext: [role] }, correlationId: 'c' });
const IN_WINDOW = new Date('2026-10-21T09:00:00.000Z');

function rig(now = IN_WINDOW, form = anActiveForm()) {
  const forms = new InMemoryForms();
  forms.stored.set(form.formId, form);
  const content = new InMemoryContent();
  for (let n = 1; n <= 6; n += 1) content.items.set(id(TAG.itemVersion, n), { itemVersionId: id(TAG.itemVersion, n), stem: `q${n}` });
  content.stimuli.set(id(TAG.stimulus, 1), { stimulusVersionId: id(TAG.stimulus, 1), body: 'passage' });
  return { handler: new GetFormPackageHandler({ forms, content, clock: { now: () => now }, signer: aSigner() }), content, forms, form };
}

describe('GetFormPackage', () => {
  it('builds the package for an open form, reading each pinned version once', async () => {
    const { handler, content, form } = rig();
    const built = expectValue(await handler.handle({ formId: form.formId }, ctx('learner')));
    expect(built.formId).toBe(form.formId);
    expect(built.slotIds).toHaveLength(6);
    expect(new TextDecoder().decode(built.bytes)).toContain('"formatVersion":1');
    expect(content.asked.filter((q) => q.startsWith('item '))).toHaveLength(6);
    expect(content.asked.filter((q) => q.startsWith('stimulus '))).toEqual([`stimulus ${id(TAG.stimulus, 1)}`]);
  });

  it('reads a version two slots share once', async () => {
    const shared = anActiveForm();
    const { handler, content } = rig(IN_WINDOW, shared);
    const duplicate = { ...shared, sections: shared.sections.map((section) => ({ ...section, slots: section.slots.map((slot) => ({ ...slot, itemVersionId: id(TAG.itemVersion, 1) })) })) };
    (rig as unknown as void);
    const forms = new InMemoryForms();
    forms.stored.set(shared.formId, duplicate);
    const once = new GetFormPackageHandler({ forms, content, clock: { now: () => IN_WINDOW }, signer: aSigner() });
    await once.handle({ formId: shared.formId }, ctx('learner'));
    expect(content.asked.filter((q) => q.startsWith('item '))).toHaveLength(1);
  });

  it('is for learners, content ops and the system, and for no one else', async () => {
    const { handler, form } = rig();
    for (const role of ['learner', 'content_ops', 'system']) expect((await handler.handle({ formId: form.formId }, ctx(role))).ok, role).toBe(true);
    for (const role of ['guest', 'author', 'reviewer', 'generation_pipeline']) {
      expect(expectError(await handler.handle({ formId: form.formId }, ctx(role))).kind, role).toBe('Authorization');
    }
  });

  it('refuses a form that is not active, and one whose window is not open at this moment even though its state says active', async () => {
    const draft = rig(IN_WINDOW, aPublishedForm());
    expect(expectError(await draft.handler.handle({ formId: draft.form.formId }, ctx('learner'))).code).toBe('PACKAGE_FORM_NOT_ACTIVE');
    const early = rig(new Date('2026-10-21T07:59:59.999Z'));
    expect(expectError(await early.handler.handle({ formId: early.form.formId }, ctx('learner'))).code).toBe('FORM_WINDOW_NOT_OPEN');
    const late = rig(new Date('2026-10-21T12:00:00.000Z'));
    expect(expectError(await late.handler.handle({ formId: late.form.formId }, ctx('learner'))).code).toBe('FORM_WINDOW_NOT_OPEN');
  });

  it('says NotFound for a form that is not there, and passes content\'s refusal through unchanged', async () => {
    const { handler, content, form } = rig();
    expect(expectError(await handler.handle({ formId: id(TAG.form, 9) }, ctx('learner'))).kind).toBe('NotFound');
    content.failWith = { kind: 'Unavailable', code: 'DOWN', message: 'content is down' };
    expect(expectError(await handler.handle({ formId: form.formId }, ctx('learner'))).code).toBe('DOWN');
    content.failWith = null;
    content.items.delete(id(TAG.itemVersion, 3));
    expect(expectError(await handler.handle({ formId: form.formId }, ctx('learner'))).kind).toBe('NotFound');
    content.items.set(id(TAG.itemVersion, 3), { itemVersionId: id(TAG.itemVersion, 3) });
    content.stimuli.clear();
    expect(expectError(await handler.handle({ formId: form.formId }, ctx('learner'))).kind).toBe('NotFound');
  });

  it('refuses when the view content returned is for another version than the pin', async () => {
    const { handler, content, form } = rig();
    content.items.set(id(TAG.itemVersion, 2), { itemVersionId: id(TAG.itemVersion, 222) });
    expect(expectError(await handler.handle({ formId: form.formId }, ctx('learner'))).code).toBe('PACKAGE_VIEW_DISAGREES_WITH_PIN');
  });
});

describe('signing (M6-26)', () => {
  it('signs the exact bytes it returns, and the signature verifies against the key it publishes', async () => {
    const { handler, form } = rig();
    const built = expectValue(await handler.handle({ formId: form.formId }, ctx('learner')));
    const signer = aSigner();
    expect(verifyPackage(built.bytes, built.signature, signer.publicKey)).toBe(true);
    expect(built.keyId).toBe(signer.keyId);
    expect(built.digest).toBe(signer.sign(built.bytes).digest);
  });

  it('serves nothing, unsigned, when no key is configured — before reading the form', async () => {
    const forms = new InMemoryForms();
    const content = new InMemoryContent();
    const handler = new GetFormPackageHandler({ forms, content, clock: { now: () => IN_WINDOW }, signer: undefined });
    const error = expectError(await handler.handle({ formId: id(TAG.form, 1) }, ctx('learner')));
    expect(error.kind).toBe('Unavailable');
    expect(error.code).toBe('PACKAGE_SIGNING_UNAVAILABLE');
    expect(content.asked).toEqual([]);
  });
});

describe('GetPackageSigningKey', () => {
  it('publishes the public key and its id, never the seed', async () => {
    const signer = aSigner();
    const view = expectValue(await new GetPackageSigningKeyHandler({ signer }).handle({}, ctx('learner')));
    expect(view).toEqual({ algorithm: 'Ed25519', keyId: signer.keyId, publicKey: signer.publicKey });
    expect(JSON.stringify(view)).not.toContain(TEST_SIGNING_SEED);
  });

  it('is for learners, content ops and the system; says unavailable with no key', async () => {
    const handler = new GetPackageSigningKeyHandler({ signer: aSigner() });
    for (const role of ['learner', 'content_ops', 'system']) expect((await handler.handle({}, ctx(role))).ok, role).toBe(true);
    expect(expectError(await handler.handle({}, ctx('guest'))).kind).toBe('Authorization');
    expect(expectError(await new GetPackageSigningKeyHandler({ signer: undefined }).handle({}, ctx('learner'))).code).toBe('PACKAGE_SIGNING_UNAVAILABLE');
  });
});
