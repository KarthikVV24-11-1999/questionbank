import type { FormEvent, JSX } from 'react';
import type { ProfileApi } from '../api/learning-api.js';
import type { ExamChoicesDto, LearnerProfileDto, OnboardingStep, ProfileChange, ScopeOptionsDto } from '../api/learning-schemas.js';
import { mergeChange, sendDraft, withDraft, type DraftStore, type Standing } from '../onboarding/draft.js';
import { sentDraft, stepCompleted } from '../onboarding/onboarding-events.js';
import { TOKENS } from '../tokens.js';
import { screenHref, type ScreenContext } from './screen-context.js';
import { useRemote, useSubmit } from './use-remote.js';

/**
 * Who the learner is, and what they have studied (M8-22, FR-STU-01, FR-STU-02). One question at a time, in the order the server asks them, and **every one of them can be left**: the way out is
 * on the screen from the first question, it is a link to the product and not a refusal, and nothing the learner opens afterwards asks for any of this.
 *
 * **Offline.** An answer is written to the device first and sent second (`onboarding/draft.ts`). With no connection the learner has still answered, is told so in a sentence, and the answer is
 * sent when the connection returns. What the screen cannot do offline is offer a list it has not got: the exams and the chapters come from the server, so the first and the third
 * question say that plainly and offer the way out (D109 in docs/DEBT.md); the class and a past score are the learner's own words and need nothing.
 *
 * It holds no state of its own: the profile and the draft are read when it opens, the form is read when it is sent, and a step that is done reopens the screen at the next, as the other screens
 * are opened. Where the learner was is not remembered anywhere; it is worked out from what they have said.
 */
interface Loaded {
  readonly profile: LearnerProfileDto | null;
  readonly draft: ProfileChange | null;
  readonly standing: Standing;
  readonly choices: ExamChoicesDto | null;
  readonly options: ScopeOptionsDto | null;
  /** The chapters are being asked again, though the profile has some: by request, or because the syllabus has moved on. */
  readonly reopened: boolean;
  readonly openedAtMs: number;
}

const CLASSES: ReadonlyArray<readonly ['class_11' | 'class_12' | 'repeater', string]> = [
  ['class_11', 'Class 11'],
  ['class_12', 'Class 12'],
  ['repeater', 'Repeating a year'],
];

const SAVED_HERE = 'Saved on this device. It will be sent when you are back online.';

/** `edit: 'coverage'` opens the chapters again for a learner who has already given them. A scope the syllabus has moved on from (`needs_review`) opens them without being asked. */
export function OnboardingScreen({ profiles, drafts, edit = null, context, onOpen }: { readonly profiles: ProfileApi; readonly drafts: DraftStore; readonly edit?: 'coverage' | null; readonly context: ScreenContext; readonly onOpen: (href: string) => void }): JSX.Element {
  const loaded = useRemote<Loaded>(async () => {
    const openedAtMs = context.analytics.nowMs();
    // Anything waiting is sent before the screen is drawn, so that what is shown is what the server holds.
    await sendDraft({ drafts, profiles }, sentDraft(context.analytics));
    const [profile, draft] = await Promise.all([profiles.getProfile().catch(() => null), drafts.read().catch(() => null)]);
    const standing = withDraft(profile, draft);
    const choices = standing.next === 'exam' ? await profiles.examChoices().catch(() => null) : null;
    const reopened = standing.examCode !== null && (edit === 'coverage' || profile?.scope?.status === 'needs_review');
    const options = standing.next === 'coverage' || reopened ? await profiles.scopeOptions().catch(() => null) : null;
    return { profile, draft, standing, choices, options, reopened, openedAtMs };
  });

  const home = screenHref({}, context);
  const here = (): void => onOpen(screenHref({ onboarding: true }, context));

  const save = useSubmit(
    async ({ step, form, read, opened }: { readonly step: OnboardingStep; readonly form: FormData; readonly read: (form: FormData) => ProfileChange; readonly opened: number }) => {
      const change = read(form);
      // writing replaces the key, so what is already waiting is folded in first
      const kept = await drafts.write(mergeChange(await drafts.read().catch(() => null), change)).then(() => true, () => false);
      if (kept) {
        const sent = await sendDraft({ drafts, profiles }, sentDraft(context.analytics));
        if (sent.outcome === 'refused') throw new Error(sent.message);
      } else {
        const profile = await profiles.updateProfile(change);
        sentDraft(context.analytics)(change, profile);
      }
      stepCompleted(context.analytics, step, opened);
    },
    here,
  );
  const skip = useSubmit(
    () => profiles.skipOnboarding().then(() => undefined, () => undefined),
    () => onOpen(home),
  );

  return (
    <main aria-label="About you" style={{ padding: TOKENS.spaceMedium }}>
      <h1>About you</h1>
      <p>A few questions so we can start you in the right place. You can skip all of them and use everything.</p>
      {loaded.status === 'loading' ? <p role="status">One moment…</p> : null}
      {loaded.status === 'failed' ? <p role="alert">{loaded.message}</p> : null}
      {loaded.status === 'loaded' ? <Step loaded={loaded.value} coverageHref={screenHref({ onboarding: 'coverage' }, context)} save={(step, form, read) => save.go({ step, form, read, opened: loaded.value.openedAtMs })} busy={save.busy} /> : null}
      {save.failure === null ? null : <p role="alert">{save.failure}</p>}
      <p>
        <a href={home} onClick={(event) => (event.preventDefault(), skip.go(undefined))}>
          Skip for now
        </a>
      </p>
    </main>
  );
}

function Step({ loaded, coverageHref, save, busy }: { readonly loaded: Loaded; readonly coverageHref: string; readonly save: (step: OnboardingStep, form: FormData, read: (form: FormData) => ProfileChange) => void; readonly busy: boolean }): JSX.Element {
  const { standing } = loaded;
  const waiting = loaded.draft !== null && Object.keys(loaded.draft).length > 0;
  const submit = (step: OnboardingStep, read: (form: FormData) => ProfileChange) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save(step, new FormData(event.currentTarget), read);
  };
  const offlineNote = loaded.profile === null ? <p role="note">You appear to be offline. What you answer is kept on this device and sent when you are back.</p> : null;
  const waitingNote = waiting ? <p role="note">{SAVED_HERE}</p> : null;

  if (standing.next === 'exam') {
    const exams = loaded.choices?.exams ?? [];
    return (
      <form aria-label="Your exam" onSubmit={submit('exam', (form) => {
        const [examCode = '', targetYear = ''] = String(form.get('exam') ?? '').split('|');
        if (examCode === '' || targetYear === '') throw new Error('Choose an exam and a year.');
        return { examCode, targetYear };
      })}>
        {offlineNote}
        {waitingNote}
        {exams.length === 0 ? (
          <p role="note">The list of exams cannot be loaded right now. You can skip this and come back to it.</p>
        ) : (
          <>
            <label>
              Which exam are you preparing for?{' '}
              <select name="exam" defaultValue="">
                <option value="" disabled>
                  Choose one
                </option>
                {exams.flatMap((exam) => exam.years.map((year) => (
                  <option key={`${exam.examCode}|${year}`} value={`${exam.examCode}|${year}`}>
                    {exam.displayName} — {year}
                  </option>
                )))}
              </select>
            </label>
            <button type="submit" disabled={busy}>
              Continue
            </button>
          </>
        )}
      </form>
    );
  }

  if (standing.next === 'class') {
    return (
      <form aria-label="Your class" onSubmit={submit('class', (form) => {
        const chosen = CLASSES.find(([value]) => value === form.get('class'));
        if (chosen === undefined) throw new Error('Choose one.');
        return { currentClass: chosen[0] };
      })}>
        {offlineNote}
        {waitingNote}
        <fieldset>
          <legend>Where are you in school?</legend>
          {CLASSES.map(([value, label]) => (
            <label key={value} style={{ display: 'block' }}>
              <input type="radio" name="class" value={value} /> {label}
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={busy}>
          Continue
        </button>
      </form>
    );
  }

  if (standing.next === 'coverage' || loaded.reopened) {
    const options = loaded.options;
    const stale = loaded.profile?.scope?.status === 'needs_review';
    return (
      <form aria-label="What you have studied" onSubmit={submit('coverage', (form) => {
        const picked = form.getAll('chapter').map(String);
        if (picked.length === 0) throw new Error('Pick at least one chapter, or skip for now.');
        return { scopeNodeIds: picked };
      })}>
        {offlineNote}
        {waitingNote}
        {stale ? <p role="note">The syllabus has been updated since you chose what you have studied. Choose again.</p> : null}
        {options === null ? (
          <p role="note">The syllabus cannot be loaded right now. You can skip this and come back to it.</p>
        ) : (
          <>
            <fieldset>
              <legend>Which of these have you already studied?</legend>
              {options.nodes.map((node) => (
                <label key={node.nodeId} style={{ display: 'block', marginLeft: `${node.depth * 16}px` }}>
                  <input type="checkbox" name="chapter" value={node.nodeId} defaultChecked={options.selected.includes(node.nodeId)} /> {node.displayName}
                </label>
              ))}
            </fieldset>
            <p role="note">Practice and what we suggest next are drawn from these. A mock exam is always the full paper.</p>
            <button type="submit" disabled={busy}>
              Continue
            </button>
          </>
        )}
      </form>
    );
  }

  return (
    <section aria-label="All set">
      <p role="status">You are all set.</p>
      {waitingNote}
      <p>
        <a href={coverageHref}>Change what you have studied</a>
      </p>
      {standing.priorScore === null ? (
        <form aria-label="A past score" onSubmit={submit('prior_score', (form) => {
          const value = Number(form.get('value'));
          const outOf = Number(form.get('outOf'));
          if (!(Number.isFinite(value) && Number.isFinite(outOf)) || outOf <= 0 || value < 0 || value > outOf) throw new Error('Enter a score and the total it was out of.');
          return { priorScore: { value, outOf } };
        })}>
          <p>If you have a past score, it helps. This is optional.</p>
          <label>
            Score <input type="number" name="value" step="any" min="0" />
          </label>{' '}
          <label>
            out of <input type="number" name="outOf" step="any" min="1" />
          </label>{' '}
          <button type="submit" disabled={busy}>
            Save
          </button>
        </form>
      ) : null}
    </section>
  );
}
