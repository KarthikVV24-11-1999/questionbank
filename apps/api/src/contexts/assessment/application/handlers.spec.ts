import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { InMemoryAttempts, InMemoryContent, InMemoryForms, InMemoryResponses, StubCorpus, StubPins, aSigner } from '../../../testing/assessment-fakes.js';
import { TAG, aDraftForm, aPublishedForm, anActiveForm, anAttempt, id, WINDOW, WITHIN_WINDOW } from '../../../testing/assessment-fixtures.js';
import type { AssemblyCandidate } from '../domain/assembly.js';
import { abandonAttempt, startAttempt } from '../domain/attempt.js';
import { conflictError, validationError } from '../domain/assessment-error.js';
import { applicationError } from './authorization.js';
import { composeAssessmentHandlers } from './compose-handlers.js';
import type { AssembleDraftForm } from './commands/form-commands.js';
import { AssembleDraftFormHandler, GetFormHandler, PublishFormHandler, ScheduleFormHandler, fromAssembly } from './handlers/form-handlers.js';
import { SweepWindowsHandler } from './handlers/sweep-handler.js';
import type { ApplicationContext, AuditRecord, LoadedCorpus } from './ports.js';

const NOW = new Date('2026-10-21T07:30:00.000Z');
const ctx = (role: string, extra: Partial<ApplicationContext> = {}): ApplicationContext => ({
  principal: { kind: role === 'system' ? 'system' : 'human', id: id(TAG.student, 9), roleContext: [role] },
  correlationId: 'corr-1',
  ...extra,
});
const ops = ctx('content_ops', { stepUpSatisfied: true });

function rig(overrides: { clock?: Date; corpus?: LoadedCorpus | ReturnType<typeof applicationError> } = {}) {
  const forms = new InMemoryForms();
  const attempts = new InMemoryAttempts();
  const responses = new InMemoryResponses();
  const recorded: AuditRecord[] = [];
  let n = 0;
  const deps = {
    forms,
    attempts,
    responses,
    corpus: new StubCorpus(overrides.corpus ?? pool()),
    content: new InMemoryContent(),
    clock: { now: () => overrides.clock ?? NOW },
    identifiers: { next: () => id(0xd0, (n += 1)) },
    audit: { record: async (entry: AuditRecord) => void recorded.push(entry) },
    signer: aSigner(),
    pins: new StubPins(),
  };
  return { deps, forms, attempts, responses, recorded };
}

const cand = (n: number, o: Partial<AssemblyCandidate> = {}): AssemblyCandidate => ({
  itemId: id(TAG.item, n),
  itemVersionId: id(TAG.itemVersion, n),
  itemType: 'SINGLE_CORRECT_MCQ',
  difficultyBand: 'moderate',
  conceptIdentityIds: [id(0xc0, n)],
  stimulusVersionId: null,
  isPublished: true,
  isAnchor: false,
  anchorExposureCap: null,
  ...o,
});
const pool = (): LoadedCorpus => ({
  candidates: [cand(1, { isAnchor: true, anchorExposureCap: 9 }), cand(2), cand(3), cand(4)],
  exposure: new Map(),
  nearDuplicates: new Map(),
  unevaluated: [id(TAG.itemVersion, 77)],
});

const command = (over: Partial<AssembleDraftForm> = {}): AssembleDraftForm => ({
  blueprint: {
    examProfileVersionId: id(TAG.profile),
    formType: 'mock',
    totalMarks: 8,
    difficultyTolerance: 0,
    sections: [{ ordinal: 1, sectionSpecRef: 'physics', itemCount: 2, typeMix: { SINGLE_CORRECT_MCQ: 2 }, marksPerItem: 4, difficultyTarget: { moderate: 2 } }],
  },
  sessionRefs: ['2026-01-27/shift-1'],
  ...over,
});

describe('AssembleDraftForm', () => {
  it('assembles a draft from the corpus, saves it and says how well the soft constraints were met', async () => {
    const { deps, forms, recorded } = rig();
    const result = expectValue(await new AssembleDraftFormHandler(deps).handle(command(), ops));
    expect(result.form.state).toBe('draft');
    expect(result.form.formType).toBe('mock');
    expect(result.form.sessionRefs).toEqual(['2026-01-27/shift-1']);
    expect(result.form.sections[0]!.slots).toHaveLength(2);
    expect(result.form.sections[0]!.slots.some((slot) => slot.isAnchor)).toBe(true);
    expect(result.soft.difficultyShortfall).toBe(0);
    expect(result.unevaluated).toEqual([id(TAG.itemVersion, 77)]);
    expect(forms.stored.get(result.form.formId)?.state).toBe('draft');
    expect(recorded.map((r) => [r.action, r.targetContext, r.targetType, r.targetId, r.correlationId])).toEqual([
      ['AssembleDraftForm', 'assessment', 'form', result.form.formId, 'corr-1'],
    ]);
  });

  it('asks the corpus only for the item types the blueprint wants, and the subject it was given', async () => {
    const { deps } = rig();
    await new AssembleDraftFormHandler(deps).handle(command({ subject: 'physics' }), ops);
    expect(deps.corpus.requests).toEqual([{ subject: 'physics', itemTypes: ['SINGLE_CORRECT_MCQ'] }]);
    await new AssembleDraftFormHandler(deps).handle(command(), ctx('system'));
    expect(deps.corpus.requests[1]).toEqual({ itemTypes: ['SINGLE_CORRECT_MCQ'] });
  });

  it('is open to the system and to content ops, and to nobody else', async () => {
    const { deps } = rig();
    const handler = new AssembleDraftFormHandler(deps);
    expect((await handler.handle(command(), ctx('system'))).ok).toBe(true);
    for (const role of ['learner', 'reviewer', 'author', 'guest', 'exam_owner']) {
      expect(expectError(await handler.handle(command(), ctx(role))).kind, role).toBe('Authorization');
    }
  });

  it('gives each slot an id of its own, taken from the identifier factory', async () => {
    const { deps } = rig();
    const result = expectValue(await new AssembleDraftFormHandler(deps).handle(command(), ops));
    const ids = result.form.sections.flatMap((s) => s.slots.map((slot) => slot.slotId));
    expect(new Set(ids).size).toBe(2);
  });

  it('refuses a blueprint that is malformed, a corpus it cannot read, and a form it cannot build', async () => {
    const { deps } = rig();
    const handler = new AssembleDraftFormHandler(deps);
    expect(expectError(await handler.handle(command({ blueprint: { ...command().blueprint, totalMarks: 0 } }), ops)).code).toBe('BLUEPRINT_TOTAL_MARKS_INVALID');
    expect(expectError(await handler.handle(command({ sessionRefs: [] }), ops)).code).toBe('FORM_SESSIONS_INVALID');
    const unreadable = applicationError('PreconditionFailed', 'CORPUS_UNAVAILABLE', 'the catalogue could not be read');
    expect(expectError(await new AssembleDraftFormHandler(rig({ corpus: unreadable }).deps).handle(command(), ops))).toEqual(unreadable);
  });

  it('reports an impossible blueprint and an exhausted search as DIFFERENT things', async () => {
    const infeasible = expectError(await new AssembleDraftFormHandler(rig().deps).handle(command({ blueprint: { ...command().blueprint, totalMarks: 100 } }), ops));
    expect(infeasible.code).toBe('ASSEMBLY_INFEASIBLE');
    expect(infeasible.kind).toBe('RuleViolation');
    expect(infeasible.detail).toEqual({ constraint: 'TOTAL_MARKS' });

    // Infeasible only deep in the search: the supply checks pass, so the search must run, and it is cut short.
    const shared = id(TAG.stimulus, 1);
    const blocked: LoadedCorpus = {
      candidates: [1, 2, 3, 4].map((n) => cand(n, { stimulusVersionId: shared, isAnchor: n === 1, anchorExposureCap: n === 1 ? 9 : null })),
      exposure: new Map(),
      nearDuplicates: new Map(),
      unevaluated: [],
    };
    const four = (n: number) => ({ ordinal: n, sectionSpecRef: `s${n}`, itemCount: 1, typeMix: { SINGLE_CORRECT_MCQ: 1 }, marksPerItem: 4, difficultyTarget: { moderate: 1 } });
    const blueprint = { ...command().blueprint, totalMarks: 16, sections: [four(1), four(2), four(3), four(4)] };
    const exhausted = expectError(await new AssembleDraftFormHandler(rig({ corpus: blocked }).deps).handle(command({ blueprint, maxSteps: 3 }), ops));
    expect(exhausted.code).toBe('ASSEMBLY_SEARCH_EXHAUSTED');
    expect(exhausted.kind).toBe('Unavailable');
    expect(exhausted.detail).toEqual({ constraint: 'STIMULUS_SPLIT' });
    // and without the cut-off the same blueprint is shown impossible
    expect(expectError(await new AssembleDraftFormHandler(rig({ corpus: blocked }).deps).handle(command({ blueprint }), ops)).code).toBe('ASSEMBLY_INFEASIBLE');
    expect(infeasible.message).not.toBe(exhausted.message);
  });

  it('maps both assembly refusals the same way fromAssembly does, and keeps their codes apart', () => {
    const base = { kind: 'PreconditionFailed' as const, message: 'm', constraint: 'ITEM_COUNT' as const };
    expect(fromAssembly({ ...base, code: 'ASSEMBLY_INFEASIBLE' }).kind).toBe('RuleViolation');
    expect(fromAssembly({ ...base, code: 'ASSEMBLY_SEARCH_EXHAUSTED' }).kind).toBe('Unavailable');
    expect(fromAssembly({ ...base, code: 'ASSEMBLY_INFEASIBLE' }).location).toBeUndefined();
  });

  it('reports a failed save and writes no audit record for it', async () => {
    const { deps, forms, recorded } = rig();
    forms.failSaveWith = conflictError('CONFLICT', 'no', 'form');
    expect(expectError(await new AssembleDraftFormHandler(deps).handle(command(), ops)).code).toBe('CONFLICT');
    expect(recorded).toEqual([]);
  });
});

describe('PublishForm', () => {
  it('publishes a stored draft through the repository, audits it, and needs step-up', async () => {
    const { deps, forms, recorded } = rig();
    const draft = aDraftForm();
    forms.publishedAnchors.add(id(TAG.itemVersion, 1));
    await forms.save(draft);
    const handler = new PublishFormHandler(deps);
    expect(expectError(await handler.handle({ formId: draft.formId }, ctx('content_ops'))).code).toBe('STEP_UP_REQUIRED');
    const view = expectValue(await handler.handle({ formId: draft.formId }, ops));
    expect(view.state).toBe('published');
    expect(view.publishedAt).toBe(NOW.toISOString());
    expect(recorded.map((r) => r.action)).toEqual(['PublishForm']);
  });

  it('refuses anyone but content ops, and reports a refusal from the repository', async () => {
    const { deps, forms } = rig();
    await forms.save(aDraftForm());
    const handler = new PublishFormHandler(deps);
    for (const role of ['system', 'learner', 'exam_owner']) {
      expect(expectError(await handler.handle({ formId: id(TAG.form) }, ctx(role, { stepUpSatisfied: true }))).kind, role).toBe('Authorization');
    }
    expect(expectError(await handler.handle({ formId: id(TAG.form) }, ops)).code).toBe('FORM_ANCHOR_FLAG_DISAGREES_WITH_POOL');
    expect(expectError(await handler.handle({ formId: id(TAG.form, 9) }, ops)).kind).toBe('NotFound');
  });
});

describe('ScheduleForm', () => {
  it('schedules a published form and audits it', async () => {
    const { deps, forms, recorded } = rig();
    forms.stored.set(id(TAG.form), aPublishedForm());
    const view = expectValue(await new ScheduleFormHandler(deps).handle({ formId: id(TAG.form), opensAt: WINDOW.opensAt, closesAt: WINDOW.closesAt }, ctx('content_ops')));
    expect(view.state).toBe('embargoed');
    expect(view.scheduleWindow).toEqual(WINDOW);
    expect(recorded.map((r) => r.action)).toEqual(['ScheduleForm']);
  });

  it('refuses system and learners, a window the domain refuses, and a form that is not there', async () => {
    const { deps, forms } = rig();
    forms.stored.set(id(TAG.form), aPublishedForm());
    const handler = new ScheduleFormHandler(deps);
    const bad = { formId: id(TAG.form), opensAt: WINDOW.closesAt, closesAt: WINDOW.opensAt };
    for (const role of ['system', 'learner']) expect(expectError(await handler.handle(bad, ctx(role))).kind).toBe('Authorization');
    expect(expectError(await handler.handle(bad, ctx('content_ops'))).code).toBe('FORM_WINDOW_INVALID');
    expect(expectError(await handler.handle({ ...bad, formId: id(TAG.form, 9) }, ctx('content_ops'))).kind).toBe('NotFound');
  });
});

describe('GetForm', () => {
  it('returns the operator\'s view, field by field, with no content in it', async () => {
    const { deps, forms } = rig();
    forms.stored.set(id(TAG.form), aPublishedForm());
    const view = expectValue(await new GetFormHandler(deps).handle({ formId: id(TAG.form) }, ctx('system')));
    expect(view.formId).toBe(id(TAG.form));
    expect(view.sections.flatMap((s) => s.slots)).toHaveLength(6);
    const slot = view.sections[0]!.slots[0]!;
    expect(Object.keys(slot).sort()).toEqual(['isAnchor', 'itemId', 'itemVersionId', 'marksAvailable', 'ordinal', 'slotId', 'stimulusVersionId']);
    expect('stimulusVersionId' in view.sections[0]!.slots[1]!).toBe(false);
    expect(view.scheduleWindow).toBeUndefined();
    expect(Object.isFrozen(view)).toBe(true);
  });

  it('shows the window of a scheduled form, and refuses a learner and a missing form', async () => {
    const { deps, forms } = rig();
    forms.stored.set(id(TAG.form), anActiveForm());
    const handler = new GetFormHandler(deps);
    expect(expectValue(await handler.handle({ formId: id(TAG.form) }, ctx('content_ops'))).scheduleWindow).toEqual(WINDOW);
    expect(expectError(await handler.handle({ formId: id(TAG.form) }, ctx('learner'))).kind).toBe('Authorization');
    expect(expectError(await handler.handle({ formId: id(TAG.form, 9) }, ctx('content_ops'))).kind).toBe('NotFound');
  });
});

describe('SweepWindows — the operation a scheduler will call (D36)', () => {
  const AFTER = new Date('2026-10-21T12:00:00.000Z');
  const system = ctx('system');

  it('opens a form whose window has begun and closes one whose window has ended', async () => {
    const { deps, forms, recorded } = rig({ clock: new Date('2026-10-21T08:00:00.000Z') });
    forms.stored.set(id(TAG.form), await scheduled());
    const report = expectValue(await new SweepWindowsHandler(deps).handle({}, system));
    expect([report.formsOpened, report.formsClosed]).toEqual([1, 0]);
    expect(forms.stored.get(id(TAG.form))?.state).toBe('active');
    const later = rig({ clock: AFTER });
    later.forms.stored.set(id(TAG.form), anActiveForm());
    expect(expectValue(await new SweepWindowsHandler(later.deps).handle({}, system)).formsClosed).toBe(1);
    expect(recorded.map((r) => r.action)).toEqual(['SweepWindows']);
  });

  async function scheduled() {
    const { aScheduledForm } = await import('../../../testing/assessment-fixtures.js');
    return aScheduledForm();
  }

  it('abandons a never-started attempt and an in-progress one with no response, once their window has closed', async () => {
    const { deps, attempts } = rig({ clock: AFTER });
    const created = anAttempt();
    const started = expectValue(startAttempt(anAttempt({ attemptId: id(TAG.attempt, 2), studentId: id(TAG.student, 2) }), '2026-10-21T09:00:00.000Z'));
    attempts.stored.set(created.attemptId, created);
    attempts.stored.set(started.attemptId, started);
    const report = expectValue(await new SweepWindowsHandler(deps).handle({}, system));
    expect(report.attemptsAbandoned).toBe(2);
    expect([...attempts.stored.values()].map((a) => a.state)).toEqual(['abandoned', 'abandoned']);
  });

  it('leaves an attempt that holds a response for submission, and does not abandon it', async () => {
    const { deps, attempts, responses } = rig({ clock: AFTER });
    const started = expectValue(startAttempt(anAttempt(), '2026-10-21T09:00:00.000Z'));
    attempts.stored.set(started.attemptId, started);
    responses.answered.set(started.attemptId, 3);
    const report = expectValue(await new SweepWindowsHandler(deps).handle({}, system));
    expect([report.attemptsAbandoned, report.attemptsLeftForSubmission]).toEqual([0, 1]);
    expect(attempts.stored.get(started.attemptId)?.state).toBe('in_progress');
  });

  it('does nothing before a window has closed, and is idempotent after', async () => {
    const early = rig({ clock: new Date('2026-10-21T11:59:59.999Z') });
    early.attempts.stored.set(id(TAG.attempt), anAttempt());
    expect(expectValue(await new SweepWindowsHandler(early.deps).handle({}, system)).attemptsAbandoned).toBe(0);
    const late = rig({ clock: AFTER });
    late.attempts.stored.set(id(TAG.attempt), anAttempt());
    const handler = new SweepWindowsHandler(late.deps);
    expect(expectValue(await handler.handle({}, system)).attemptsAbandoned).toBe(1);
    expect(expectValue(await handler.handle({}, system)).attemptsAbandoned).toBe(0);
  });

  it('names a move that did not apply and carries on with the rest', async () => {
    const { deps, attempts, responses, forms } = rig({ clock: AFTER });
    const a = anAttempt();
    const b = anAttempt({ attemptId: id(TAG.attempt, 2), studentId: id(TAG.student, 2) });
    const c = anAttempt({ attemptId: id(TAG.attempt, 3), studentId: id(TAG.student, 3) });
    for (const attempt of [a, b, c]) attempts.stored.set(attempt.attemptId, attempt);
    attempts.stale.add(a.attemptId);
    responses.failFor = b.attemptId;
    forms.stored.set(id(TAG.form), anActiveForm());
    forms.stored.set(id(TAG.form, 2), { ...anActiveForm(), formId: id(TAG.form, 2) });
    const report = expectValue(await new SweepWindowsHandler(deps).handle({}, system));
    expect(report.attemptsAbandoned).toBe(1);
    expect(report.formsClosed).toBe(2);
    expect(report.skipped).toEqual([`abandon ${a.attemptId}: CONFLICT`, `abandon ${b.attemptId}: CONFLICT`]);
  });

  it('names a form that would not move', async () => {
    const { deps, forms } = rig({ clock: new Date('2026-10-21T08:00:00.000Z') });
    const embargoed = await scheduled();
    forms.stored.set(id(TAG.form), embargoed);
    // the repository finds it due, but by the time the move is made the clock inside the domain says otherwise
    forms.findDueToOpen = async () => ({ ok: true, value: [{ ...embargoed, scheduleWindow: { opensAt: '2026-10-21T07:00:00.000Z', closesAt: WINDOW.closesAt } }] });
    forms.stored.set(id(TAG.form), { ...embargoed, scheduleWindow: { opensAt: '2026-10-21T09:00:00.000Z', closesAt: WINDOW.closesAt } });
    const report = expectValue(await new SweepWindowsHandler(deps).handle({}, system));
    expect(report.formsOpened).toBe(0);
    expect(report.skipped[0]).toContain('open');
  });

  it('names a form that would not close', async () => {
    const { deps, forms } = rig({ clock: new Date('2026-10-21T11:00:00.000Z') });
    const active = anActiveForm();
    forms.stored.set(id(TAG.form), active);
    forms.findDueToClose = async () => ({ ok: true, value: [active] });
    const report = expectValue(await new SweepWindowsHandler(deps).handle({}, system));
    expect(report.formsClosed).toBe(0);
    expect(report.skipped[0]).toContain('close');
  });

  it('reports a store it cannot read, at each of the three reads', async () => {
    const failure = validationError('PERSISTENCE_REJECTED', 'no');
    const asFail = () => async () => ({ ok: false as const, error: failure });
    const first = rig();
    first.forms.findDueToOpen = asFail();
    expect(expectError(await new SweepWindowsHandler(first.deps).handle({}, system)).code).toBe('PERSISTENCE_REJECTED');
    const second = rig();
    second.forms.findDueToClose = asFail();
    expect(expectError(await new SweepWindowsHandler(second.deps).handle({}, system)).code).toBe('PERSISTENCE_REJECTED');
    const third = rig();
    third.attempts.failFindWith = failure;
    expect(expectError(await new SweepWindowsHandler(third.deps).handle({}, system)).code).toBe('PERSISTENCE_REJECTED');
  });

  it('skips an attempt the domain will not abandon', async () => {
    const { deps, attempts } = rig({ clock: AFTER });
    const created = anAttempt();
    attempts.stored.set(created.attemptId, created);
    attempts.findAbandonable = async () => ({ ok: true, value: [expectValue(abandonAttempt(created, AFTER.toISOString(), 0))] });
    const report = expectValue(await new SweepWindowsHandler(deps).handle({}, system));
    expect(report.attemptsAbandoned).toBe(0);
    expect(report.skipped[0]).toContain('ATTEMPT_TRANSITION_PROHIBITED');
  });

  it('is the scheduler\'s alone', async () => {
    const { deps } = rig();
    for (const role of ['content_ops', 'learner', 'exam_owner']) {
      expect(expectError(await new SweepWindowsHandler(deps).handle({}, ctx(role))).kind, role).toBe('Authorization');
    }
  });
});

describe('the composed registry', () => {
  it('registers exactly the twelve handlers, each with a policy, and admits system to exactly five of them', () => {
    const registry = composeAssessmentHandlers(rig().deps);
    expect([...registry.names].sort()).toEqual(['AssembleDraftForm', 'CreateAttempt', 'GetAttempt', 'GetForm', 'GetFormPackage', 'GetPackageSigningKey', 'IngestResponseEvents', 'PublishForm', 'ScheduleForm', 'StartAttempt', 'SubmitAttempt', 'SweepWindows']);
    const admitting = (role: string) => registry.names.filter((name) => registry.get(name)?.policy.allowedRoles.includes(role)).sort();
    expect(admitting('system')).toEqual(['AssembleDraftForm', 'GetForm', 'GetFormPackage', 'GetPackageSigningKey', 'SweepWindows']);
    expect(admitting('content_ops')).toEqual(['AssembleDraftForm', 'GetForm', 'GetFormPackage', 'GetPackageSigningKey', 'PublishForm', 'ScheduleForm']);
    // a student reaches the package of a form that is open, the key that verifies it, and their own attempt's lifecycle
    expect(admitting('learner')).toEqual(['CreateAttempt', 'GetAttempt', 'GetFormPackage', 'GetPackageSigningKey', 'IngestResponseEvents', 'StartAttempt', 'SubmitAttempt']);
    for (const role of ['guest', 'author', 'reviewer', 'generation_pipeline']) expect(admitting(role), role).toEqual([]);
  });

  it('keeps publication a person\'s: system cannot publish or schedule, and publication needs step-up', () => {
    const registry = composeAssessmentHandlers(rig().deps);
    expect(registry.get('PublishForm')?.policy).toMatchObject({ allowedRoles: ['content_ops'], requiresStepUp: true });
    expect(registry.get('ScheduleForm')?.policy.allowedRoles).not.toContain('system');
    expect(registry.get('SweepWindows')?.policy.allowedRoles).toEqual(['system']);
  });
});
