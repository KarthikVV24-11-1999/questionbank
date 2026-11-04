import { NAMES_PER_REQUEST, type LearningApi } from '../api/learning-api.js';
import type { NamedConceptDto } from '../api/learning-schemas.js';

/**
 * What a topic is called, for the screens that are handed one by its identifier (M8-29, D88). An identifier is never what a learner reads: the home screen's next action, a report's findings and its pace
 * are all topics the server names by id, and the name comes from the server's own syllabus, with the chapter and subject above it.
 *
 * Asked for in the syllabus version each topic came from, in pages of what a request takes; a topic whose name could not be read is called **"This topic"** and never by what it is filed under, so a
 * failure of the names makes a screen vaguer and not wrong. The reading screens ask softly (`.catch`) for the same reason: the report does not wait on a name.
 */
export interface TopicRef {
  readonly taxonomyVersionId: string;
  readonly conceptIdentityId: string;
}

export type TopicNames = ReadonlyMap<string, NamedConceptDto>;

export const NO_NAMES: TopicNames = new Map();

export async function nameTopics(learning: Pick<LearningApi, 'conceptNames'>, refs: readonly TopicRef[]): Promise<TopicNames> {
  const byTaxonomy = new Map<string, Set<string>>();
  for (const ref of refs) byTaxonomy.set(ref.taxonomyVersionId, (byTaxonomy.get(ref.taxonomyVersionId) ?? new Set<string>()).add(ref.conceptIdentityId));
  const names = new Map<string, NamedConceptDto>();
  for (const [taxonomyVersionId, ids] of byTaxonomy) {
    const asked = [...ids];
    for (let from = 0; from < asked.length; from += NAMES_PER_REQUEST) {
      for (const named of await learning.conceptNames(taxonomyVersionId, asked.slice(from, from + NAMES_PER_REQUEST))) names.set(named.conceptIdentityId, named);
    }
  }
  return names;
}

/** Like `nameTopics`, and a screen that can do without the names gets none rather than a failure. */
export const nameTopicsSoftly = (learning: Pick<LearningApi, 'conceptNames'>, refs: readonly TopicRef[]): Promise<TopicNames> => nameTopics(learning, refs).catch(() => NO_NAMES);

export const FALLBACK_NAME = 'This topic';
export const SEPARATOR = ' › ';

export const topicName = (names: TopicNames, conceptIdentityId: string): string => names.get(conceptIdentityId)?.name ?? FALLBACK_NAME;

/** "Physics › Mechanics": where a topic sits, or nothing when it is not known or sits at the top. */
export const topicPlace = (names: TopicNames, conceptIdentityId: string): string => (names.get(conceptIdentityId)?.path ?? []).join(SEPARATOR);
