import { describe, expect, it } from 'vitest';
import { attemptDto, FakeApi } from '../testing/fakes.js';
import { PROFILE, concept } from '../testing/learning-fixtures.js';
import { PRACTICE_RUN_SIZE, startPracticeOn } from './start-practice.js';

const api = () => new FakeApi({} as never, new Error('no key'));

describe('the one tap (M7-58)', () => {
  it('makes a run about the one concept under the profile, with the tap\'s key, and starts it', async () => {
    const server = api();
    const started = await startPracticeOn(server, { examProfileVersionId: PROFILE, conceptIdentityId: concept(1), idempotencyKey: 'page:c1' });
    expect(server.practiceRequests).toEqual([{ request: { examProfileVersionId: PROFILE, conceptIdentityIds: [concept(1)], count: PRACTICE_RUN_SIZE }, key: 'page:c1' }]);
    expect(server.calls).toEqual(['createPracticeAttempt', 'startAttempt']);
    expect(started).toEqual(attemptDto());
  });

  it('starts the run it made and no other', async () => {
    const server = api();
    const started: string[] = [];
    server.startAttempt = (async (attemptId: string) => (started.push(attemptId), attemptDto())) as never;
    await startPracticeOn(server, { examProfileVersionId: PROFILE, conceptIdentityId: concept(1), idempotencyKey: 'k' });
    expect(started).toEqual(['run-1']);
  });

  it('starts nothing when the run could not be made, and says why by letting the failure through', async () => {
    const server = api();
    server.createPracticeAttempt = async () => {
      throw new Error('NO_ITEMS_MATCH');
    };
    await expect(startPracticeOn(server, { examProfileVersionId: PROFILE, conceptIdentityId: concept(1), idempotencyKey: 'k' })).rejects.toThrow('NO_ITEMS_MATCH');
    expect(server.calls).toEqual([]);
  });

  it('sends the same key on a second try, so a tap retried after the create made it makes no second run', async () => {
    const server = api();
    server.startAttempt = async () => {
      throw new TypeError('Failed to fetch');
    };
    const tap = () => startPracticeOn(server, { examProfileVersionId: PROFILE, conceptIdentityId: concept(1), idempotencyKey: 'page:c1' });
    await expect(tap()).rejects.toThrow('Failed to fetch');
    await expect(tap()).rejects.toThrow('Failed to fetch');
    expect(server.practiceRequests.map((sent) => sent.key)).toEqual(['page:c1', 'page:c1']);
  });
});
