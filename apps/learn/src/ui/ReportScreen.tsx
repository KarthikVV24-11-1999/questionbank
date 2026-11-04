import { useEffect, type JSX } from 'react';
import type { AssessmentApi } from '../api/assessment-api.js';
import type { LearningApi, ProfileApi } from '../api/learning-api.js';
import type { DiagnosticReportDto, PaceAnalyticsDto } from '../api/learning-schemas.js';
import { pinsOf, type ExamPins } from '../home/exam-pins.js';
import { nameTopicsSoftly, topicName, type TopicNames } from '../names/topic-names.js';
import { rescoreLabel, type RescoreLabel } from '../report/rescore-label.js';
import { TOKENS } from '../tokens.js';
import { PractiseButton } from './PractiseButton.js';
import { screenHref, type ScreenContext } from './screen-context.js';
import { useRemote } from './use-remote.js';

interface Loaded {
  readonly report: DiagnosticReportDto;
  /** `null` where the pace could not be read: the report stands without it, and says so. */
  readonly pace: PaceAnalyticsDto | null;
  readonly label: RescoreLabel;
  /** When the score the report is about was computed, if it could be read. */
  readonly resultAt: string | null;
  /** The learner's exam, for a practice run to be made under; `null` where it could not be read or none is chosen. */
  readonly exam: ExamPins | null;
  readonly names: TopicNames;
}

/** The report, and beside it what can be read: the pace, the score that stands, the learner's exam and what the topics are called. Only the report is required; the others fail soft and say so. */
async function loadReport(learning: LearningApi, assessment: Pick<AssessmentApi, 'getResult'>, profiles: Pick<ProfileApi, 'getProfile'>, attemptId: string): Promise<Loaded> {
  const [report, pace, result, profile] = await Promise.all([
    learning.getReport(attemptId),
    learning.getPace(attemptId).catch(() => null),
    assessment.getResult(attemptId).catch(() => null),
    profiles.getProfile().catch(() => null),
  ]);
  const standing = result?.score === undefined ? null : { scoreRecordId: result.score.scoreRecordId, generation: result.score.generation };
  // the pace names its topics by the rows of its own table, which carry the syllabus version; a question's topic is one of them
  const names = await nameTopicsSoftly(learning, [...report.findings, ...(pace?.concepts ?? [])]);
  return { report, pace, label: rescoreLabel(report, standing), resultAt: result?.score?.computedAt ?? null, exam: pinsOf(profile), names };
}

function Rescored({ label }: { readonly label: RescoreLabel }): JSX.Element | null {
  if (label.kind === 'replaced') {
    return <p role="note">This report is of an earlier score. Your paper has since been re-scored (score {label.generation}), and a report for the new score has not been made yet.</p>;
  }
  if (label.kind === 'rescored') return <p role="note">Your paper was re-scored. This report is for the score that stands (score {label.generation}).</p>;
  return null;
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`;

/** Time against outcome per concept. A question the interval cap hid the time of is **not known**, and is shown as that and never folded into fast or slow. */
function Pace({ pace, names }: { readonly pace: PaceAnalyticsDto; readonly names: TopicNames }): JSX.Element {
  const unknown = pace.slots.filter((slot) => slot.pace === 'unknown');
  return (
    <section aria-label="Pace">
      <h2>Time against outcome</h2>
      <table>
        <caption>Questions by how long you took and how they went</caption>
        <thead>
          <tr>
            <th scope="col">Topic</th>
            <th scope="col">Slow and right</th>
            <th scope="col">Slow and wrong</th>
            <th scope="col">Fast and right</th>
            <th scope="col">Fast and wrong</th>
            <th scope="col">Not known</th>
          </tr>
        </thead>
        <tbody>
          {pace.concepts.map((concept) => (
            <tr key={concept.conceptIdentityId}>
              <th scope="row">{topicName(names, concept.conceptIdentityId)}</th>
              <td>{concept.slowCorrect}</td>
              <td>{concept.slowWrong}</td>
              <td>{concept.fastCorrect}</td>
              <td>{concept.fastWrong}</td>
              <td>{concept.unknownCorrect + concept.unknownWrong}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {unknown.length === 0 ? null : (
        <>
          <h3>Not known</h3>
          <p>For these questions the time could not be told apart from a long pause, so they are not counted as fast or as slow.</p>
          <ul aria-label="Questions whose time is not known">
            {unknown.map((slot) => (
              <li key={slot.slotRef}>
                {topicName(names, slot.conceptIdentityId)}: at least {seconds(slot.atLeastMs)}, {slot.atMostMs === null ? 'no upper limit known' : `at most ${seconds(slot.atMostMs)}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The report (M7-59): findings ranked by marks lost, each with its remediation one tap away, and the pace beside them. */
export function ReportScreen({
  learning,
  assessment,
  profiles,
  attemptId,
  context,
  onOpen,
}: {
  readonly learning: LearningApi;
  /** Where the learner's exam comes from, for the practice run each finding offers. */
  readonly profiles: Pick<ProfileApi, 'getProfile'>;
  readonly assessment: Pick<AssessmentApi, 'getResult' | 'createPracticeAttempt' | 'startAttempt'>;
  readonly attemptId: string;
  readonly context: ScreenContext;
  readonly onOpen: (href: string) => void;
}): JSX.Element {
  const loaded = useRemote(() => loadReport(learning, assessment, profiles, attemptId));
  // `mock.diagnostic_viewed`: the report was shown. The screen has no drill-down, so the deepest level reached is the top one (0).
  useEffect(() => {
    if (loaded.status === 'loaded') context.analytics.emit('mock.diagnostic_viewed', { findings_shown: loaded.value.report.findings.length, deepest_drill_level: 0 }, { attempt_id: attemptId });
  }, [loaded.status]);
  return (
    <main aria-label="Report" style={{ padding: TOKENS.spaceMedium }}>
      <h1>Your report</h1>
      {loaded.status === 'loading' ? <p role="status">Opening your report…</p> : null}
      {loaded.status === 'failed' ? <p role="alert">{loaded.message}</p> : null}
      {loaded.status === 'loaded' ? (
        <>
          <Rescored label={loaded.value.label} />
          <section aria-label="Findings">
            <h2>Where the marks went</h2>
            {loaded.value.report.findings.length === 0 ? <p>No marks were lost.</p> : null}
            <ol>
              {[...loaded.value.report.findings]
                .sort((a, b) => a.rank - b.rank)
                .map((finding) => (
                  <li key={finding.conceptIdentityId}>
                    <h3>{topicName(loaded.value.names, finding.conceptIdentityId)}</h3>
                    <p>
                      Lost {finding.marksLost} of {finding.marksAvailable} marks across {finding.slots} {finding.slots === 1 ? 'question' : 'questions'}
                      {finding.skipped > 0 ? `, ${finding.skipped} skipped` : ''}.
                    </p>
                    <PractiseButton conceptIdentityId={finding.conceptIdentityId} label={`Practise ${topicName(loaded.value.names, finding.conceptIdentityId)}`} source="remediation" finding={{ rank: finding.rank, resultAt: loaded.value.resultAt }} exam={loaded.value.exam} assessment={assessment} context={context} onOpen={onOpen} />
                  </li>
                ))}
            </ol>
          </section>
          {loaded.value.pace === null ? <p role="note">The time analysis for this paper could not be read.</p> : <Pace pace={loaded.value.pace} names={loaded.value.names} />}
        </>
      ) : null}
      <a href={screenHref({})}>Back to what to do next</a>
    </main>
  );
}
