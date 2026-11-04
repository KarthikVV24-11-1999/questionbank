import type { JSX } from 'react';
import type { AssessmentApi } from '../api/assessment-api.js';
import type { LearningApi, ProfileApi } from '../api/learning-api.js';
import type { LearnerProfileDto, StandingDto } from '../api/learning-schemas.js';
import { DIAGNOSTIC_LENGTH } from '../practice/start-practice.js';
import { pinsOf, type ExamPins } from '../home/exam-pins.js';
import { chooseNextAction, type NextAction } from '../home/next-action.js';
import { NO_NAMES, nameTopicsSoftly, topicName, topicPlace, type TopicNames } from '../names/topic-names.js';
import { TOKENS } from '../tokens.js';
import { DiagnosticButton } from './DiagnosticButton.js';
import { PractiseButton } from './PractiseButton.js';
import { screenHref, type ScreenContext } from './screen-context.js';
import { useRemote } from './use-remote.js';

const WHY = {
  escalated: 'This topic keeps slipping, so more of the same will not fix it. Work on it directly.',
  due: 'This topic is due for review.',
} as const;

/**
 * Why the weakest topic is the one to work on, said as sure as the map is (M8-37, D117). The map says a standing with too few answers is *too early to say*; this screen used to call the same topic "the topic you are weakest on",
 * so the two disagreed about how sure the product was. The sentence is chosen by the standing's own kind: stated plainly only when the standing is asserted, and otherwise as what it is, a starting point from the answers so far. A topic whose
 * standing could not be read is hedged the same way, because not knowing is not a reason to sound sure.
 */
function weakestBecause(standing: StandingDto | null): string {
  switch (standing?.kind) {
    case 'asserted':
      return 'This is the topic you are weakest on.';
    case 'tentative':
    case 'unassessed':
    case undefined:
      return 'This is the topic you are weakest on so far. You have not answered enough on it yet for us to be sure.';
  }
}

interface Home {
  /** `null` where the profile could not be read: the invitation to say who you are is never why a learner cannot get on. */
  readonly profile: LearnerProfileDto | null;
  readonly pins: ExamPins | null;
  readonly action: NextAction;
  /** How the topic the action is about stands now, where the action is the weakest topic; `null` where it is another action, or the map could not be read. */
  readonly standing: StandingDto | null;
  readonly names: TopicNames;
}

/** The profile, then the one next action it makes possible (the taxonomy "weakest" is asked about is the profile's), then the name of the topic the action is about. */
async function loadHome(learning: LearningApi, profiles: Pick<ProfileApi, 'getProfile'> | undefined, lastAttemptId: string | null): Promise<Home> {
  const profile = profiles === undefined ? null : await profiles.getProfile().catch(() => null);
  const pins = pinsOf(profile);
  const action = await chooseNextAction({ learning, taxonomyVersionId: pins?.taxonomyVersionId ?? null, declaredScope: profile?.scope != null, lastAttemptId });
  const names = action.kind === 'practise' ? await nameTopicsSoftly(learning, [{ taxonomyVersionId: action.taxonomyVersionId, conceptIdentityId: action.conceptIdentityId }]) : NO_NAMES;
  // the weakest topic is said as sure as the map is, so the map is asked how it stands; the invitation and every other action need no more than they have
  const map = action.kind === 'practise' && action.why === 'weakest' ? await learning.getConceptMap().catch(() => null) : null;
  const standing = map?.concepts.find((topic) => action.kind === 'practise' && topic.conceptIdentityId === action.conceptIdentityId)?.standing ?? null;
  return { profile, pins, action, standing, names };
}

function Action({ home, assessment, context, onOpen }: { readonly home: Home; readonly assessment: Pick<AssessmentApi, 'createPracticeAttempt' | 'createDiagnosticAttempt' | 'startAttempt'>; readonly context: ScreenContext; readonly onOpen: (href: string) => void }): JSX.Element {
  const { action, names } = home;
  if (action.kind === 'practise') {
    const place = topicPlace(names, action.conceptIdentityId);
    return (
      <>
        <h2>{topicName(names, action.conceptIdentityId)}</h2>
        {place === '' ? null : <p aria-label="Where it sits in the syllabus">{place}</p>}
        <p>{action.why === 'weakest' ? weakestBecause(home.standing) : WHY[action.why]}</p>
        <PractiseButton conceptIdentityId={action.conceptIdentityId} label="Practise this" source="recommendation" exam={home.pins} assessment={assessment} context={context} onOpen={onOpen} />
      </>
    );
  }
  if (action.kind === 'diagnostic') {
    return (
      <>
        <h2>See where you stand</h2>
        <p>Answer {DIAGNOSTIC_LENGTH} short questions across the chapters you have studied, and we will show you which topics need work.</p>
        <DiagnosticButton exam={home.pins} assessment={assessment} context={context} onOpen={onOpen} />
      </>
    );
  }
  if (action.kind === 'read-report') {
    return (
      <>
        <h2>Your last paper</h2>
        <p>Your report is ready.</p>
        <a href={screenHref({ report: action.attemptId })}>Read your report</a>
      </>
    );
  }
  return <p>There is nothing to do right now. When you have sat a paper, what to work on next appears here.</p>;
}

/** The screen a learner opens (M7-57): one next action, chosen by the server's answers, and not a list of everything available. */
export function HomeScreen({
  learning,
  assessment,
  profiles,
  context,
  onOpen,
}: {
  readonly learning: LearningApi;
  readonly assessment: Pick<AssessmentApi, 'createPracticeAttempt' | 'createDiagnosticAttempt' | 'startAttempt'>;
  /** Where the learner's exam and the invitation to say who you are come from. Absent, or unreachable, and the screen is as it was. */
  readonly profiles?: Pick<ProfileApi, 'getProfile'>;
  readonly context: ScreenContext;
  readonly onOpen: (href: string) => void;
}): JSX.Element {
  const home = useRemote(() => loadHome(learning, profiles, context.lastAttemptId));
  return (
    <main aria-label="Home" style={{ padding: TOKENS.spaceMedium }}>
      <h1>What to do next</h1>
      {home.status === 'loading' ? <p role="status">Looking at where you are…</p> : null}
      {home.status === 'failed' ? <p role="alert">{home.message}</p> : null}
      {home.status === 'loaded' ? <Action home={home.value} assessment={assessment} context={context} onOpen={onOpen} /> : null}
      {home.status === 'loaded' && home.value.profile !== null && home.value.profile.onboarding.next !== null && !home.value.profile.onboarding.skipped ? (
        <p>
          <a href={screenHref({ onboarding: true })}>Tell us about your exam</a> (optional) so we can start you in the right place.
        </p>
      ) : null}
      <p>
        <a href={screenHref({ map: true })}>See where you stand</a>
      </p>
    </main>
  );
}
