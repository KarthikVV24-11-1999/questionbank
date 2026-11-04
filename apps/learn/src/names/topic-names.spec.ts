import { describe, expect, it } from 'vitest';
import { NAMES_PER_REQUEST } from '../api/learning-api.js';
import { FakeLearningApi } from '../testing/fakes.js';
import { concept, TAXONOMY, TOPICS } from '../testing/learning-fixtures.js';
import { FALLBACK_NAME, NO_NAMES, nameTopics, nameTopicsSoftly, topicName, topicPlace } from './topic-names.js';

const OTHER = '00000000-0000-4000-8000-0000000000d2';

describe('naming the topics a screen was handed by identifier (M8-29)', () => {
  it('names each topic once however many times it is handed, in the syllabus version it came from', async () => {
    const learning = new FakeLearningApi();
    const names = await nameTopics(learning, [
      { taxonomyVersionId: TAXONOMY, conceptIdentityId: concept(1) },
      { taxonomyVersionId: TAXONOMY, conceptIdentityId: concept(1) },
      { taxonomyVersionId: TAXONOMY, conceptIdentityId: concept(2) },
    ]);
    expect(learning.calls).toEqual([`conceptNames ${TAXONOMY} ${concept(1)},${concept(2)}`]);
    expect([...names.keys()]).toEqual([concept(1), concept(2)]);
    expect(names.get(concept(1))).toEqual(TOPICS[0]);
  });

  it('asks once for each syllabus version', async () => {
    const learning = new FakeLearningApi();
    await nameTopics(learning, [
      { taxonomyVersionId: TAXONOMY, conceptIdentityId: concept(1) },
      { taxonomyVersionId: OTHER, conceptIdentityId: concept(2) },
      { taxonomyVersionId: TAXONOMY, conceptIdentityId: concept(3) },
    ]);
    expect(learning.calls).toEqual([`conceptNames ${TAXONOMY} ${concept(1)},${concept(3)}`, `conceptNames ${OTHER} ${concept(2)}`]);
  });

  it('pages at what one request takes and not a topic over it', async () => {
    const learning = new FakeLearningApi();
    const many = Array.from({ length: NAMES_PER_REQUEST + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    for (const id of many) learning.topics.set(id, { conceptIdentityId: id, name: `Topic ${id.slice(-3)}`, path: [] });
    const names = await nameTopics(learning, many.map((conceptIdentityId) => ({ taxonomyVersionId: TAXONOMY, conceptIdentityId })));
    const sizes = learning.calls.map((call) => call.split(' ')[2]!.split(',').length);
    expect(sizes).toEqual([NAMES_PER_REQUEST, 1]);
    expect(names.size).toBe(NAMES_PER_REQUEST + 1);
  });

  it('asks nothing when there is nothing to name', async () => {
    const learning = new FakeLearningApi();
    expect((await nameTopics(learning, [])).size).toBe(0);
    expect(learning.calls).toEqual([]);
  });

  it('fails when a name cannot be read, and gives none when asked softly', async () => {
    const learning = new FakeLearningApi();
    learning.namesFail = new TypeError('Failed to fetch');
    await expect(nameTopics(learning, [{ taxonomyVersionId: TAXONOMY, conceptIdentityId: concept(1) }])).rejects.toThrow('Failed to fetch');
    expect(await nameTopicsSoftly(learning, [{ taxonomyVersionId: TAXONOMY, conceptIdentityId: concept(1) }])).toBe(NO_NAMES);
  });

  it('calls a topic by its name and says where it sits, and never falls back to the identifier', () => {
    const names = new Map([[concept(1), TOPICS[0]!]]);
    expect(topicName(names, concept(1))).toBe('Kinematics');
    expect(topicPlace(names, concept(1))).toBe('Physics › Mechanics');
    expect(topicName(names, concept(2))).toBe(FALLBACK_NAME);
    expect(topicName(NO_NAMES, concept(2))).toBe('This topic');
    expect(topicPlace(NO_NAMES, concept(2))).toBe('');
    expect(topicPlace(new Map([[concept(1), { ...TOPICS[0]!, path: [] }]]), concept(1))).toBe('');
  });
});
