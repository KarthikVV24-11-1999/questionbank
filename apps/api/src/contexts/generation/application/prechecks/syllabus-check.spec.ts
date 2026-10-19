import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { aCandidate, aRun, versionId, USAGE } from '../../../../testing/generation-fixtures.js';
import { contextFor, principalWith } from '../../../../testing/generation-context.js';
import { RecordedProvider } from '../../infrastructure/provider/recorded-provider.js';
import { err, ok } from '../../domain/result.js';
import { applicationError } from '../authorization.js';
import type { ApplicationContext, JudgementProvider, JudgementRequest, SyllabusReader, SyllabusVersion } from '../ports.js';
import { syllabusScopeCheck } from './syllabus-check.js';

const RECORDINGS = join(dirname(fileURLToPath(import.meta.url)), '../../infrastructure/provider/recordings');
const CONFIG = { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 25) };
const machine = contextFor(principalWith(['generation_pipeline'], 'system'));
const BODY = (JSON.parse(readFileSync(join(RECORDINGS, 'kinematics-ramp.json'), 'utf8')) as { response: { body: Record<string, unknown> } }).response.body;
const TAG = (BODY['taxonomyTags'] as { conceptIdentityId: string; taxonomyVersionId: string }[])[0]!;
const candidate = (body: Record<string, unknown> = BODY) => aCandidate(aRun({ promptVersionId: versionId('prompt', 7) }), { body });

const published = (concepts = [{ conceptIdentityId: TAG.conceptIdentityId, displayName: 'Kinematics' }], state = 'published'): SyllabusVersion => ({
  taxonomyVersionId: TAG.taxonomyVersionId,
  state,
  concepts,
});

/** A reader that answers from a table and remembers who asked. */
function reader(answers: Record<string, SyllabusVersion | 'missing' | ReturnType<typeof applicationError>>): { syllabus: SyllabusReader; asked: { id: string; context: ApplicationContext }[] } {
  const asked: { id: string; context: ApplicationContext }[] = [];
  return {
    asked,
    syllabus: {
      read: async (id, context) => {
        asked.push({ id, context });
        const answer = answers[id];
        if (answer === 'missing' || answer === undefined) return err(applicationError('NotFound', 'NOT_FOUND', `no taxonomy ${id}`));
        return 'kind' in answer ? err(answer) : ok(answer);
      },
    },
  };
}

function observed(): { judge: JudgementProvider; asked: JudgementRequest[] } {
  const real = RecordedProvider.fromDirectory(RECORDINGS);
  const asked: JudgementRequest[] = [];
  return { asked, judge: { judge: (request) => (asked.push(request), real.judge(request)) } };
}

const check = (syllabus: SyllabusReader, judge: JudgementProvider) => syllabusScopeCheck({ syllabus, judge, config: CONFIG });

describe('check 5 — syllabus scope conformance', () => {
  it('is the blocking check named syllabus_scope', () => {
    expect(check(reader({}).syllabus, observed().judge).check).toBe('syllabus_scope');
  });

  it('passes when every concept is a member of a published version and the classification agrees, recording the model’s reasoning', async () => {
    const { syllabus, asked: reads } = reader({ [TAG.taxonomyVersionId]: published() });
    const { judge, asked } = observed();
    const outcome = expectValue(await check(syllabus, judge).run(candidate(), machine));

    expect(outcome.outcome).toBe('pass');
    expect(outcome.detail).toContain('Kinematics as the syllabus defines it');
    expect(reads.map((read) => read.id)).toEqual([TAG.taxonomyVersionId]);
    expect(reads[0]?.context).toBe(machine);
    expect(asked).toHaveLength(1);
  });

  it('shows the classifier the concepts curriculum named, by curriculum’s own display name — not a tag list of generation’s', async () => {
    const { syllabus } = reader({ [TAG.taxonomyVersionId]: published() });
    const { judge, asked } = observed();
    await check(syllabus, judge).run(candidate(), machine);
    expect(asked[0]?.input['concepts']).toEqual([{ conceptIdentityId: TAG.conceptIdentityId, displayName: 'Kinematics' }]);
    expect(asked[0]?.promptVersionId).toBe(CONFIG.promptVersionId);
  });

  describe('membership fails, as a verdict, before any classification is attempted', () => {
    async function failing(syllabus: SyllabusReader, body: Record<string, unknown> = BODY) {
      const { judge, asked } = observed();
      const outcome = expectValue(await check(syllabus, judge).run(candidate(body), machine));
      expect(outcome.outcome).toBe('fail');
      expect(asked).toEqual([]);
      return outcome.detail ?? '';
    }

    it('a concept that is not in the version it is tagged against', async () => {
      const detail = await failing(reader({ [TAG.taxonomyVersionId]: published([{ conceptIdentityId: 'someone-else', displayName: 'Other' }]) }).syllabus);
      expect(detail).toBe(`concept ${TAG.conceptIdentityId} is not in taxonomy version ${TAG.taxonomyVersionId}`);
    });

    it('a version that is not published', async () => {
      const detail = await failing(reader({ [TAG.taxonomyVersionId]: published(undefined, 'draft') }).syllabus);
      expect(detail).toBe(`taxonomy version ${TAG.taxonomyVersionId} is draft, not published`);
    });

    it('a version that does not exist', async () => {
      const detail = await failing(reader({}).syllabus);
      expect(detail).toBe(`taxonomy version ${TAG.taxonomyVersionId} does not exist`);
    });

    it('a proposal with no concept tags at all, in any form', async () => {
      for (const taxonomyTags of [[], undefined, 'physics', [null, { conceptIdentityId: 5 }]]) {
        expect(await failing(reader({}).syllabus, { ...BODY, taxonomyTags })).toContain('no concept tags');
      }
    });

    it('reporting every problem, once each, when several tags are wrong', async () => {
      const other = { conceptIdentityId: 'c-2', taxonomyVersionId: 'v-2' };
      const detail = await failing(reader({ [TAG.taxonomyVersionId]: published([]) }).syllabus, { ...BODY, taxonomyTags: [TAG, TAG, other] });
      expect(detail.split('; ')).toEqual([
        `concept ${TAG.conceptIdentityId} is not in taxonomy version ${TAG.taxonomyVersionId}`,
        'taxonomy version v-2 does not exist',
      ]);
    });
  });

  it('reads each taxonomy version once however many tags name it, and asks about each distinct concept once', async () => {
    const second = { conceptIdentityId: 'c-2', taxonomyVersionId: TAG.taxonomyVersionId };
    const { syllabus, asked: reads } = reader({
      [TAG.taxonomyVersionId]: published([{ conceptIdentityId: TAG.conceptIdentityId, displayName: 'Kinematics' }, { conceptIdentityId: 'c-2', displayName: 'Dynamics' }]),
    });
    const seen: JudgementRequest[] = [];
    const judge: JudgementProvider = { judge: async (request) => (seen.push(request), ok({ usage: USAGE, output: { outcome: 'pass', rationale: 'in scope' } })) };
    expectValue(await check(syllabus, judge).run(candidate({ ...BODY, taxonomyTags: [TAG, second, TAG] }), machine));
    expect(reads).toHaveLength(1);
    expect((seen[0]?.input['concepts'] as unknown[]).length).toBe(2);
  });

  it('records the classifier’s no as a failing verdict with its reasoning', async () => {
    const { syllabus } = reader({ [TAG.taxonomyVersionId]: published() });
    const judge: JudgementProvider = { judge: async () => ok({ usage: USAGE, output: { outcome: 'fail', rationale: 'this is organic chemistry' } }) };
    expect(expectValue(await check(syllabus, judge).run(candidate(), machine))).toEqual({ outcome: 'fail', detail: 'this is organic chemistry' });
  });

  describe('cannot run — records nothing — when', () => {
    it('curriculum refuses the caller: the refusal is curriculum’s own, returned unchanged', async () => {
      const refused = applicationError('Authorization', 'NOT_PERMITTED', 'principal may not run GetTaxonomyVersion');
      const { judge, asked } = observed();
      expect(expectError(await check(reader({ [TAG.taxonomyVersionId]: refused }).syllabus, judge).run(candidate(), machine))).toBe(refused);
      expect(asked).toEqual([]);
    });

    it('curriculum is unavailable', async () => {
      const down = applicationError('Unavailable', 'DOWN', 'later');
      expect(expectError(await check(reader({ [TAG.taxonomyVersionId]: down }).syllabus, observed().judge).run(candidate(), machine))).toBe(down);
    });

    it('the classification has no recording, or the provider fails, or the reply is unusable', async () => {
      const { syllabus } = reader({ [TAG.taxonomyVersionId]: published() });
      expect(expectError(await check(syllabus, observed().judge).run(candidate({ ...BODY, stem: 'unrecorded' }), machine)).code).toBe('NO_RECORDING_FOR_REQUEST');
      const down = applicationError('Unavailable', 'DOWN', 'later');
      expect(expectError(await check(syllabus, { judge: async () => err(down) }).run(candidate(), machine))).toBe(down);
      expect(expectError(await check(syllabus, { judge: async () => ok({ usage: USAGE, output: {} }) }).run(candidate(), machine)).code).toBe('PROVIDER_REPLY_MALFORMED');
    });
  });

  it('is red when its prompt would be the candidate’s generation prompt (F29)', async () => {
    const { syllabus } = reader({ [TAG.taxonomyVersionId]: published() });
    const { judge, asked } = observed();
    const reusing = aCandidate(aRun({ promptVersionId: CONFIG.promptVersionId }), { body: BODY });
    expect(expectError(await check(syllabus, judge).run(reusing, machine)).code).toBe('CHECK_REUSES_GENERATION_PROMPT');
    expect(asked).toEqual([]);
  });
});
