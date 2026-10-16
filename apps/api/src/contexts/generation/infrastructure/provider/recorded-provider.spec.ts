import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkNoApiKeyReadAnywhere } from '../../../../fitness/generation-rules.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { versionId } from '../../../../testing/generation-fixtures.js';
import type { ProposalRequest } from '../../application/ports.js';
import { InvalidRecordingError, RecordedProvider } from './recorded-provider.js';

const RECORDINGS = join(dirname(fileURLToPath(import.meta.url)), 'recordings');
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');

interface RecordingFile {
  request: { pin: { modelVersionId: string; promptVersionId: string }; grounding: ProposalRequest['grounding']; task: ProposalRequest['task'] };
  response: { itemType: string; body: Record<string, unknown>; confidence: number };
}

function recordingFile(name: string): RecordingFile {
  return JSON.parse(readFileSync(join(RECORDINGS, name), 'utf8')) as RecordingFile;
}

/** The request a recording answers, with a run id of the caller's own — the run is not part of the question. */
function requestFor(name: string, runId = versionId('run', 1)): ProposalRequest {
  const { request } = recordingFile(name);
  return { pin: { ...request.pin, runId }, grounding: request.grounding, task: request.task };
}

const provider = () => RecordedProvider.fromDirectory(RECORDINGS);

afterEach(() => vi.restoreAllMocks());

describe('the recorded adapter replays what was recorded', () => {
  it('has recordings committed, of both kinds, so a lookup has something to choose between', () => {
    expect(readdirSync(RECORDINGS).filter((name) => name.endsWith('.json')).sort()).toEqual([
      'ambiguity-kinematics-ramp.json',
      'ambiguity-optics-lens.json',
      'consistency-kinematics-ramp.json',
      'distractors-kinematics-ramp.json',
      'kinematics-ramp.json',
      'optics-lens.json',
      'safety-kinematics-ramp.json',
      'safety-optics-lens.json',
      'syllabus-kinematics-ramp.json',
      'verify-kinematics-ramp-1.json',
      'verify-kinematics-ramp-2.json',
      'verify-optics-lens-1.json',
      'verify-optics-lens-2.json',
    ]);
  });

  it('answers each recorded request with its recorded response, field by field', async () => {
    for (const name of ['kinematics-ramp.json', 'optics-lens.json']) {
      const recorded = recordingFile(name).response;
      const response = expectValue(await provider().propose(requestFor(name)));
      expect(response.itemType).toBe(recorded.itemType);
      expect(response.confidence).toBe(recorded.confidence);
      expect((response.body['subject'] as string)).toBe(recorded.body['subject']);
      expect(Object.keys(response).sort()).toEqual(['body', 'confidence', 'itemType']);
    }
  });

  it('tells the two recordings apart', async () => {
    const ramp = expectValue(await provider().propose(requestFor('kinematics-ramp.json')));
    const lens = expectValue(await provider().propose(requestFor('optics-lens.json')));
    expect(ramp.confidence).toBe(0.874);
    expect(lens.confidence).toBe(0.62);
    expect(JSON.stringify(ramp.body)).not.toBe(JSON.stringify(lens.body));
  });
});

describe('deterministic — the same request yields the same bytes', () => {
  it('twice from one adapter, twice from two, and equal to the recorded bytes', async () => {
    const request = requestFor('kinematics-ramp.json');
    const one = provider();
    const first = JSON.stringify(expectValue(await one.propose(request)));
    const second = JSON.stringify(expectValue(await one.propose(request)));
    const fresh = JSON.stringify(expectValue(await provider().propose(request)));

    expect(second).toBe(first);
    expect(fresh).toBe(first);
    expect(first).toBe(JSON.stringify(recordingFile('kinematics-ramp.json').response));
  });

  it('whatever order the request’s fields arrive in, and whichever run asks', async () => {
    const original = requestFor('optics-lens.json');
    const reordered: ProposalRequest = {
      task: Object.fromEntries(Object.entries(original.task).reverse()),
      grounding: original.grounding,
      pin: { runId: versionId('run', 77), promptVersionId: original.pin.promptVersionId, modelVersionId: original.pin.modelVersionId },
    };
    const a = JSON.stringify(expectValue(await provider().propose(original)));
    const b = JSON.stringify(expectValue(await provider().propose(reordered)));
    expect(b).toBe(a);
  });

  it('hands back a frozen response, so no caller can alter what the next one receives', async () => {
    const adapter = provider();
    const response = expectValue(await adapter.propose(requestFor('optics-lens.json')));
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.body)).toBe(true);
    expect(expectValue(await adapter.propose(requestFor('optics-lens.json')))).toBe(response);
  });
});

describe('a request with no recording fails loudly', () => {
  async function missed(change: (request: ProposalRequest) => ProposalRequest) {
    const fetched = vi.spyOn(globalThis, 'fetch');
    const failure = expectError(await provider().propose(change(requestFor('optics-lens.json'))));
    expect(fetched).not.toHaveBeenCalled();
    return failure;
  }

  it('for a different task, naming the request so the recording is easy to add', async () => {
    const failure = await missed((request) => ({ ...request, task: { ...request.task, band: 'hard' } }));
    expect(failure.kind).toBe('PreconditionFailed');
    expect(failure.code).toBe('NO_RECORDING_FOR_REQUEST');
    expect(failure.message).toContain('never calls a live provider or invents an answer');
    expect((failure.detail as { requestKey: string }).requestKey).toMatch(/^[0-9a-f]{16}$/u);
    expect(failure.message).toContain((failure.detail as { requestKey: string }).requestKey);
  });

  it('for a different model version, a different prompt version, different grounding, or grounding in another order', async () => {
    const keys = new Set<string>();
    for (const change of [
      (request: ProposalRequest): ProposalRequest => ({ ...request, pin: { ...request.pin, modelVersionId: versionId('model', 99) } }),
      (request: ProposalRequest): ProposalRequest => ({ ...request, pin: { ...request.pin, promptVersionId: versionId('prompt', 99) } }),
      (request: ProposalRequest): ProposalRequest => ({ ...request, grounding: [{ sourceId: 'other', text: 'x' }] }),
      (request: ProposalRequest): ProposalRequest => ({ ...request, grounding: [...request.grounding, { sourceId: 'extra', text: 'y' }] }),
    ]) {
      const failure = await missed(change);
      expect(failure.code).toBe('NO_RECORDING_FOR_REQUEST');
      keys.add((failure.detail as { requestKey: string }).requestKey);
    }
    expect(keys.size).toBe(4);
  });

  it('names the same key for the same missing request, so it can be found again', async () => {
    const ask = () => missed((request) => ({ ...request, task: { unrecorded: true } }));
    expect(((await ask()).detail as { requestKey: string }).requestKey).toBe(((await ask()).detail as { requestKey: string }).requestKey);
  });
});

describe('a recording that cannot be trusted refuses to load', () => {
  function directoryWith(files: Record<string, string>): string {
    const directory = mkdtempSync(join(tmpdir(), 'recordings-'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
    return directory;
  }
  const valid = JSON.stringify(recordingFile('optics-lens.json'));
  const mutated = (change: (file: RecordingFile) => void): string => {
    const file = recordingFile('optics-lens.json');
    change(file);
    return JSON.stringify(file);
  };
  const load = (files: Record<string, string>) => () => RecordedProvider.fromDirectory(directoryWith(files));

  it('loads a good directory, ignoring files that are not recordings', async () => {
    const adapter = RecordedProvider.fromDirectory(directoryWith({ 'a.json': valid, 'README.md': 'not a recording' }));
    expectValue(await adapter.propose(requestFor('optics-lens.json')));
  });

  it('an empty directory, which would make every request fail', () => {
    expect(load({})).toThrow(InvalidRecordingError);
    expect(load({ 'README.md': 'x' })).toThrow(/there are no recordings/u);
  });

  it('invalid JSON, naming the file', () => {
    expect(load({ 'broken.json': '{ not json' })).toThrow(/broken\.json is not usable: it is not valid JSON/u);
  });

  it('a file without a request and a response', () => {
    for (const text of ['[]', '{}', '{"request":{}}', '{"request":{},"response":5}', 'null']) {
      expect(load({ 'x.json': text }), text).toThrow(/must hold a "request" object and a "response" object/u);
    }
  });

  it('a request that does not name its pin, or lacks grounding or a task', () => {
    expect(load({ 'x.json': mutated((file) => { file.request.pin = {} as never; }) })).toThrow(/request\.pin must name/u);
    expect(load({ 'x.json': mutated((file) => { file.request.pin.promptVersionId = '  '; }) })).toThrow(/request\.pin must name/u);
    expect(load({ 'x.json': mutated((file) => { (file.request as { grounding: unknown }).grounding = 'x'; }) })).toThrow(/"grounding" array and a "task" object/u);
    expect(load({ 'x.json': mutated((file) => { (file.request as { task: unknown }).task = []; }) })).toThrow(/"grounding" array and a "task" object/u);
  });

  it('a response without an item type or a body', () => {
    expect(load({ 'x.json': mutated((file) => { file.response.itemType = ''; }) })).toThrow(/"itemType" and a "body" object/u);
    expect(load({ 'x.json': mutated((file) => { (file.response as { body: unknown }).body = []; }) })).toThrow(/"itemType" and a "body" object/u);
  });

  it('a confidence that is missing, not a number, or outside [0, 1]', () => {
    for (const confidence of [undefined, '0.5', -0.1, 1.1, null]) {
      expect(load({ 'x.json': mutated((file) => { (file.response as { confidence: unknown }).confidence = confidence; }) }), String(confidence)).toThrow(
        /confidence must be a number in \[0, 1\]/u,
      );
    }
  });

  it('two recordings of one request, since one question has one answer', () => {
    expect(load({ 'a.json': valid, 'b.json': valid })).toThrow(/b\.json is not usable: it records the same request as a\.json/u);
  });

  it('names the failing file in an error that says what it is', () => {
    const error = new InvalidRecordingError('f.json', 'why');
    expect(error.name).toBe('InvalidRecordingError');
    expect(error.message).toBe('recording f.json is not usable: why');
  });
});

describe('no API key is read anywhere in this repository', () => {
  it('holds across every source root, over a tree with real files in it', () => {
    expect(checkNoApiKeyReadAnywhere(REPOSITORY_ROOT)).toEqual([]);
  });

  it('is red on a planted read of an API-key-shaped variable', () => {
    const violations = checkNoApiKeyReadAnywhere(REPOSITORY_ROOT, {
      files: ['apps/api/src/fitness-fixtures/as-generation-application/planted-provider-leaks.ts'],
    });
    expect(violations.map((violation) => violation.rule)).toEqual(['EXT05_API_KEY_READ_IN_REPOSITORY']);
  });

  it('this adapter reads no environment at all', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'recorded-provider.ts'), 'utf8');
    expect(source).not.toMatch(/process\.env|import\.meta\.env/u);
  });
});

describe('the recorded adapter replays judgements too', () => {
  const MODEL = versionId('model', 5);
  const PROMPT = versionId('prompt', 20);
  const recordedJudgement = (name: string) =>
    JSON.parse(readFileSync(join(RECORDINGS, name), 'utf8')) as {
      request: { modelVersionId: string; promptVersionId: string; input: Record<string, unknown> };
      response: { output: Record<string, unknown> };
    };

  it('answers a recorded judgement with its recorded output, byte for byte, twice', async () => {
    const { request, response } = recordedJudgement('verify-optics-lens-1.json');
    const first = expectValue(await provider().judge(request));
    const second = expectValue(await provider().judge(request));
    expect(JSON.stringify(first)).toBe(JSON.stringify(response));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('tells the two attempts apart, because the attempt is part of the input', async () => {
    const one = expectValue(await provider().judge(recordedJudgement('verify-optics-lens-1.json').request));
    const two = expectValue(await provider().judge(recordedJudgement('verify-optics-lens-2.json').request));
    expect(one.output['answer']).toBe('c');
    expect(two.output['answer']).toBe('a');
  });

  it('whatever order the input’s fields arrive in', async () => {
    const { request } = recordedJudgement('verify-kinematics-ramp-1.json');
    const reordered = { ...request, input: Object.fromEntries(Object.entries(request.input).reverse()) };
    expect(JSON.stringify(expectValue(await provider().judge(reordered)))).toBe(JSON.stringify(expectValue(await provider().judge(request))));
  });

  it('is a different question under a different prompt version — which is how a verification differs from a generation', async () => {
    const { request } = recordedJudgement('verify-kinematics-ramp-1.json');
    const failure = expectError(await provider().judge({ ...request, promptVersionId: versionId('prompt', 7) }));
    expect(failure.code).toBe('NO_RECORDING_FOR_REQUEST');
    expect(failure.message).toContain('judgement request');
  });

  it('fails loudly for an input nobody recorded, never calling out', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch');
    const failure = expectError(await provider().judge({ modelVersionId: MODEL, promptVersionId: PROMPT, input: { nothing: 'recorded' } }));
    expect(failure.code).toBe('NO_RECORDING_FOR_REQUEST');
    expect(fetched).not.toHaveBeenCalled();
  });

  it('keeps proposals and judgements apart: a judgement recording never answers a proposal request, or the reverse', async () => {
    const adapter = RecordedProvider.fromRecordings([
      { source: 'j.json', content: { kind: 'judge', request: { modelVersionId: MODEL, promptVersionId: PROMPT, input: { q: 1 } }, response: { output: { a: 1 } } } },
    ]);
    expectValue(await adapter.judge({ modelVersionId: MODEL, promptVersionId: PROMPT, input: { q: 1 } }));
    expect(expectError(await adapter.propose(requestFor('optics-lens.json'))).code).toBe('NO_RECORDING_FOR_REQUEST');
  });

  it('refuses at load a judgement recording that cannot be trusted, and a kind it does not know', () => {
    const judgement = (change: (file: Record<string, unknown>) => void) => {
      const file = { kind: 'judge', request: { modelVersionId: MODEL, promptVersionId: PROMPT, input: {} }, response: { output: {} } } as Record<string, unknown>;
      change(file);
      return () => RecordedProvider.fromRecordings([{ source: 'j.json', content: file }]);
    };
    expect(judgement((file) => { (file['request'] as Record<string, unknown>)['input'] = []; })).toThrow(/needs a modelVersionId, a promptVersionId and an "input" object/u);
    expect(judgement((file) => { (file['request'] as Record<string, unknown>)['modelVersionId'] = ' '; })).toThrow(InvalidRecordingError);
    expect(judgement((file) => { file['response'] = { output: 5 }; })).toThrow(/needs an "output" object/u);
    expect(judgement((file) => { file['kind'] = 'sing'; })).toThrow(/kind "sing" is neither "propose" nor "judge"/u);
    expect(() => RecordedProvider.fromRecordings([
      { source: 'a.json', content: { kind: 'judge', request: { modelVersionId: MODEL, promptVersionId: PROMPT, input: { q: 1 } }, response: { output: {} } } },
      { source: 'b.json', content: { kind: 'judge', request: { modelVersionId: MODEL, promptVersionId: PROMPT, input: { q: 1 } }, response: { output: { other: true } } } },
    ])).toThrow(/b\.json is not usable: it records the same request as a\.json/u);
  });
});
