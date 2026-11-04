import { useEffect, type JSX } from 'react';
import type { LearningApi } from '../api/learning-api.js';
import type { ConceptMapDto, MappedConceptDto } from '../api/learning-schemas.js';
import { SEPARATOR } from '../names/topic-names.js';
import { TOKENS } from '../tokens.js';
import { screenHref, type ScreenContext } from './screen-context.js';
import { standingLine } from './standing-words.js';
import { useRemote } from './use-remote.js';

/**
 * Where the learner stands, topic by topic (M8-29, FR-STU-04): each topic the learner has answered on, under the chapter it belongs to, with how it stands and a way into the answers behind it.
 *
 * **A standing that rests on too few answers is not said as a fact.** The server sends it as `tentative`, which has no state in it; here it is drawn as "too early to say", apart from the ones that are
 * stated, and it is not counted as weak or as strong anywhere on the screen or in the event this screen emits. The topics are the learner's whole history, not only the chapters they said they have
 * studied (ADR-0062): one outside those chapters says so, and is still here.
 *
 * The map lists what the learner has answered on and counts what they have not. A list of every topic of the syllabus, answered or not, is D114 in docs/DEBT.md.
 */
function Topic({ topic }: { readonly topic: MappedConceptDto }): JSX.Element {
  return (
    <li>
      <a href={screenHref({ topic: topic.conceptIdentityId })}>{topic.name}</a>
      <p>{standingLine(topic.standing, topic.evidenceCount)}</p>
      {topic.inDeclaredScope === false ? <p>Not in the chapters you told us you have studied.</p> : null}
    </li>
  );
}

/** The topics under the chapter they sit in: chapters in the order they first appear (the server sends the syllabus's order), and each chapter's topics together. */
function groupsOf(map: ConceptMapDto): Array<{ readonly place: string; readonly topics: MappedConceptDto[] }> {
  const groups = new Map<string, MappedConceptDto[]>();
  for (const topic of map.concepts) {
    const place = topic.path.length === 0 ? 'Subjects' : topic.path.join(SEPARATOR);
    groups.set(place, [...(groups.get(place) ?? []), topic]);
  }
  return [...groups].map(([place, topics]) => ({ place, topics }));
}

const count = (map: ConceptMapDto, state: 'weak' | 'strong'): number => map.concepts.filter((topic) => topic.standing.kind === 'asserted' && topic.standing.state === state).length;

export function ConceptMapScreen({ learning, context }: { readonly learning: LearningApi; readonly context: ScreenContext }): JSX.Element {
  const loaded = useRemote(() => learning.getConceptMap());
  // `concept_map.viewed`: the whole map was shown. Only a stated standing is a weak or a strong topic; one that is too early to say is neither.
  useEffect(() => {
    if (loaded.status === 'loaded') context.analytics.emit('concept_map.viewed', { weak_count: count(loaded.value, 'weak'), strong_count: count(loaded.value, 'strong'), drill_down: false });
  }, [loaded.status]);
  const map = loaded.status === 'loaded' ? loaded.value : null;
  const early = map === null ? 0 : map.concepts.filter((topic) => topic.standing.kind === 'tentative').length;
  return (
    <main aria-label="Where you stand" style={{ padding: TOKENS.spaceMedium }}>
      <h1>Where you stand</h1>
      {loaded.status === 'loading' ? <p role="status">Opening your progress…</p> : null}
      {loaded.status === 'failed' ? <p role="alert">{loaded.message}</p> : null}
      {map === null ? null : (
        <>
          {map.concepts.length === 0 ? (
            <p>You have not answered anything yet. Once you have, each topic you have worked on shows here with how it stands.</p>
          ) : (
            <>
              <p>
                {count(map, 'strong')} strong, {count(map, 'weak')} weak{early === 0 ? '' : `, ${early} too early to say`}.
              </p>
              {groupsOf(map).map((group) => (
                <section key={group.place} aria-label={group.place}>
                  <h2>{group.place}</h2>
                  <ul>
                    {group.topics.map((topic) => (
                      <Topic key={topic.conceptIdentityId} topic={topic} />
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
          {map.unassessedCount === 0 ? null : <p>{map.unassessedCount} {map.unassessedCount === 1 ? 'topic' : 'topics'} in your syllabus you have not started yet.</p>}
        </>
      )}
      <p>
        <a href={screenHref({})}>Back to what to do next</a>
      </p>
    </main>
  );
}
