import { useEffect, type JSX } from 'react';
import type { LearningApi } from '../api/learning-api.js';
import { SEPARATOR } from '../names/topic-names.js';
import { TOKENS } from '../tokens.js';
import { screenHref, type ScreenContext } from './screen-context.js';
import { standingLine } from './standing-words.js';
import { useRemote } from './use-remote.js';

/** How many answers a page shows. The server takes up to a hundred; a phone shows fewer. */
export const ANSWERS_PER_PAGE = 20;

const when = (instant: string): string => new Date(instant).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The answers behind one topic's standing (M8-29, FR-STU-04 rule 1): newest first, a page at a time, each with when it was given and how it went. This is where "which attempts produced this" is
 * answered. Pages are addresses (`from`), so going to the next is a link and the screen keeps nothing between them. It is the drill-down target the syllabus map links to, not another way into the
 * content: it shows what the learner did, and offers no question.
 */
export function TopicScreen({ learning, conceptIdentityId, from, context }: { readonly learning: LearningApi; readonly conceptIdentityId: string; readonly from: number; readonly context: ScreenContext }): JSX.Element {
  const loaded = useRemote(() => learning.getConceptEvidence(conceptIdentityId, { limit: ANSWERS_PER_PAGE, offset: from }));
  // `concept_map.viewed`, as a drill-down: the one topic's standing is counted the way the map counts it, so a tentative one is neither weak nor strong
  useEffect(() => {
    if (loaded.status !== 'loaded') return;
    const { standing } = loaded.value;
    context.analytics.emit(
      'concept_map.viewed',
      { weak_count: standing.kind === 'asserted' && standing.state === 'weak' ? 1 : 0, strong_count: standing.kind === 'asserted' && standing.state === 'strong' ? 1 : 0, drill_down: true },
      { concept_identity_id: conceptIdentityId },
    );
  }, [loaded.status]);
  const view = loaded.status === 'loaded' ? loaded.value : null;
  const next = view === null || view.offset + view.responses.length >= view.total ? null : view.offset + view.limit;
  return (
    <main aria-label="Topic" style={{ padding: TOKENS.spaceMedium }}>
      {view === null ? <h1>Your answers</h1> : <h1>{view.concept.name}</h1>}
      {loaded.status === 'loading' ? <p role="status">Opening your answers…</p> : null}
      {loaded.status === 'failed' ? <p role="alert">{loaded.message}</p> : null}
      {view === null ? null : (
        <>
          {view.concept.path.length === 0 ? null : <p aria-label="Where it sits in the syllabus">{view.concept.path.join(SEPARATOR)}</p>}
          <p>{standingLine(view.standing, view.evidenceCount)}</p>
          <h2>The answers behind this</h2>
          <ol aria-label="Your answers, newest first" start={view.offset + 1}>
            {view.responses.map((answer) => (
              <li key={answer.evidenceId}>
                {when(answer.occurredAt)}: {answer.outcome === 'correct' ? 'right' : 'wrong'}
              </li>
            ))}
          </ol>
          {view.offset === 0 ? null : <a href={screenHref({ topic: conceptIdentityId, from: Math.max(0, view.offset - view.limit) })}>Newer answers</a>}
          {next === null ? null : <a href={screenHref({ topic: conceptIdentityId, from: next })}>Earlier answers</a>}
        </>
      )}
      <p>
        <a href={screenHref({ map: true })}>Back to where you stand</a>
      </p>
    </main>
  );
}
