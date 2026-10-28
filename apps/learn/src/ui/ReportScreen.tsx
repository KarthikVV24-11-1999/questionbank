import type { JSX } from 'react';
import type { AssessmentApi } from '../api/assessment-api.js';
import type { LearningApi } from '../api/learning-api.js';
import type { DiagnosticReportDto, PaceAnalyticsDto } from '../api/learning-schemas.js';
import { rescoreLabel, type RescoreLabel } from '../report/rescore-label.js';
import { TOKENS } from '../tokens.js';
import { PractiseButton } from './PractiseButton.js';
import { conceptLabel, screenHref, type ScreenContext } from './screen-context.js';
import { useRemote } from './use-remote.js';

interface Loaded {
  readonly report: DiagnosticReportDto;
  /** `null` where the pace could not be read: the report stands without it, and says so. */
  readonly pace: PaceAnalyticsDto | null;
  readonly label: RescoreLabel;
}

/** The report, and beside it what can be read: the pace, and the score that stands. Only the report is required; the others fail soft and say so. */
async function loadReport(learning: LearningApi, assessment: Pick<AssessmentApi, 'getResult'>, attemptId: string): Promise<Loaded> {
  const [report, pace, result] = await Promise.all([learning.getReport(attemptId), learning.getPace(attemptId).catch(() => null), assessment.getResult(attemptId).catch(() => null)]);
  const standing = result?.score === undefined ? null : { scoreRecordId: result.score.scoreRecordId, generation: result.score.generation };
  return { report, pace, label: rescoreLabel(report, standing) };
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
function Pace({ pace }: { readonly pace: PaceAnalyticsDto }): JSX.Element {
  const unknown = pace.slots.filter((slot) => slot.pace === 'unknown');
  return (
    <section aria-label="Pace">
      <h2>Time against outcome</h2>
      <table>
        <caption>Questions by how long you took and how they went</caption>
        <thead>
          <tr>
            <th scope="col">Concept</th>
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
              <th scope="row">{conceptLabel(concept.conceptIdentityId)}</th>
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
                {conceptLabel(slot.conceptIdentityId)}: at least {seconds(slot.atLeastMs)}, {slot.atMostMs === null ? 'no upper limit known' : `at most ${seconds(slot.atMostMs)}`}
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
  attemptId,
  context,
  onOpen,
}: {
  readonly learning: LearningApi;
  readonly assessment: Pick<AssessmentApi, 'getResult' | 'createPracticeAttempt' | 'startAttempt'>;
  readonly attemptId: string;
  readonly context: ScreenContext;
  readonly onOpen: (href: string) => void;
}): JSX.Element {
  const loaded = useRemote(() => loadReport(learning, assessment, attemptId));
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
                    <h3>{conceptLabel(finding.conceptIdentityId)}</h3>
                    <p>
                      Lost {finding.marksLost} of {finding.marksAvailable} marks across {finding.slots} {finding.slots === 1 ? 'question' : 'questions'}
                      {finding.skipped > 0 ? `, ${finding.skipped} skipped` : ''}.
                    </p>
                    <PractiseButton conceptIdentityId={finding.conceptIdentityId} label={`Practise ${conceptLabel(finding.conceptIdentityId)}`} assessment={assessment} context={context} onOpen={onOpen} />
                  </li>
                ))}
            </ol>
          </section>
          {loaded.value.pace === null ? <p role="note">The time analysis for this paper could not be read.</p> : <Pace pace={loaded.value.pace} />}
        </>
      ) : null}
      <a href={screenHref({}, context)}>Back to what to do next</a>
    </main>
  );
}
