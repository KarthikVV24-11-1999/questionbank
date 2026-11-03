import { describe, expect, it } from 'vitest';
import { emptyProfile, FakeProfileApi, MemoryDrafts, NODE, refusal } from '../testing/profile-fakes.js';
import { mergeChange, NO_DRAFTS, sendDraft, withDraft } from './draft.js';

describe('where the learner is, from what the server holds and what they have said since', () => {
  it('asks for the exam first, then the class, then the chapters, and then nothing: the order the server asks in', () => {
    expect(withDraft(null, null).next).toBe('exam');
    expect(withDraft(null, { examCode: 'JEE_MAIN' }).next).toBe('exam');
    expect(withDraft(null, { examCode: 'JEE_MAIN', targetYear: '2027' }).next).toBe('class');
    expect(withDraft(null, { examCode: 'JEE_MAIN', targetYear: '2027', currentClass: 'class_12' }).next).toBe('coverage');
    expect(withDraft(null, { examCode: 'JEE_MAIN', targetYear: '2027', currentClass: 'class_12', scopeNodeIds: [NODE.mechanics] }).next).toBeNull();
  });

  it('lays the draft over the profile, field by field, and a past score is never next', () => {
    const profile = { ...emptyProfile(), exam: { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'p', taxonomyVersionId: 't' } };
    expect(withDraft(profile, null).next).toBe('class');
    expect(withDraft(profile, { currentClass: 'repeater' })).toMatchObject({ examCode: 'JEE_MAIN', currentClass: 'repeater', next: 'coverage' });
    expect(withDraft(profile, { examCode: 'NEET', targetYear: '2028' })).toMatchObject({ examCode: 'NEET', targetYear: '2028' });
    const scored = { ...profile, priorScore: { value: 100, outOf: 300 } };
    expect(withDraft(scored, null).priorScore).toEqual({ value: 100, outOf: 300 });
    expect(withDraft(scored, { priorScore: null }).priorScore).toBeNull();
    expect(withDraft(scored, { priorScore: { value: 3, outOf: 4 } }).priorScore).toEqual({ value: 3, outOf: 4 });
  });

  it('a later answer replaces an earlier one to the same question and adds to the others', () => {
    expect(mergeChange({ currentClass: 'class_11', examCode: 'A' }, { currentClass: 'class_12' })).toEqual({ currentClass: 'class_12', examCode: 'A' });
    expect(mergeChange(null, { currentClass: 'class_12' })).toEqual({ currentClass: 'class_12' });
  });
});

describe('sending what is waiting', () => {
  it('sends it, removes it once the server has it, and says so', async () => {
    const profiles = new FakeProfileApi();
    const drafts = new MemoryDrafts();
    drafts.draft = { examCode: 'JEE_MAIN', targetYear: '2027' };
    const told: unknown[] = [];
    expect((await sendDraft({ drafts, profiles }, (sent) => told.push(sent))).outcome).toBe('sent');
    expect(profiles.updates).toEqual([{ examCode: 'JEE_MAIN', targetYear: '2027' }]);
    expect(drafts.draft).toBeNull();
    expect(told).toEqual([{ examCode: 'JEE_MAIN', targetYear: '2027' }]);
  });

  it('sends nothing when nothing is waiting, including an empty draft', async () => {
    const profiles = new FakeProfileApi();
    const drafts = new MemoryDrafts();
    expect((await sendDraft({ drafts, profiles })).outcome).toBe('nothing_waiting');
    drafts.draft = {};
    expect((await sendDraft({ drafts, profiles })).outcome).toBe('nothing_waiting');
    expect(profiles.calls).toEqual([]);
  });

  it('keeps it when the connection is down, and sends it when the connection is back', async () => {
    const profiles = new FakeProfileApi();
    const drafts = new MemoryDrafts();
    drafts.draft = { currentClass: 'class_12' };
    profiles.offline = true;
    expect((await sendDraft({ drafts, profiles })).outcome).toBe('kept');
    expect(drafts.draft).toEqual({ currentClass: 'class_12' });
    profiles.offline = false;
    expect((await sendDraft({ drafts, profiles })).outcome).toBe('sent');
    expect(drafts.draft).toBeNull();
  });

  it('keeps it for a rate limit and a server error, which are the server being busy and not the draft being wrong', async () => {
    for (const status of [429, 500, 503, 408]) {
      const profiles = new FakeProfileApi();
      const drafts = new MemoryDrafts();
      drafts.draft = { currentClass: 'class_12' };
      profiles.refuseNext = refusal(status, 'busy');
      expect((await sendDraft({ drafts, profiles })).outcome, String(status)).toBe('kept');
      expect(drafts.draft, String(status)).toEqual({ currentClass: 'class_12' });
    }
  });

  it('drops it, and says why, when the server will never take it', async () => {
    const profiles = new FakeProfileApi();
    const drafts = new MemoryDrafts();
    drafts.draft = { examCode: 'NO_SUCH', targetYear: '2027' };
    profiles.refuseNext = refusal(400, 'EXAM_NOT_AVAILABLE');
    expect(await sendDraft({ drafts, profiles })).toEqual({ outcome: 'refused', message: 'EXAM_NOT_AVAILABLE' });
    expect(drafts.draft).toBeNull();
  });

  it('does not throw away an answer given while the one before it was being sent', async () => {
    const profiles = new FakeProfileApi();
    const drafts = new MemoryDrafts();
    drafts.draft = { examCode: 'JEE_MAIN', targetYear: '2027' };
    const update = profiles.updateProfile.bind(profiles);
    profiles.updateProfile = async (change) => {
      const done = await update(change);
      drafts.draft = { examCode: 'JEE_MAIN', targetYear: '2027', currentClass: 'class_12' };
      return done;
    };
    await sendDraft({ drafts, profiles });
    expect(drafts.draft).toEqual({ examCode: 'JEE_MAIN', targetYear: '2027', currentClass: 'class_12' });
  });

  it('a device with no store holds nothing, says it cannot keep a draft, and has nothing to send', async () => {
    await expect(NO_DRAFTS.write({})).rejects.toThrow('cannot keep');
    expect(await NO_DRAFTS.read()).toBeNull();
    expect((await sendDraft({ drafts: NO_DRAFTS, profiles: new FakeProfileApi() })).outcome).toBe('nothing_waiting');
  });
});
