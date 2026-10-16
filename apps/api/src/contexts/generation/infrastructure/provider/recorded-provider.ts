import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { err, ok, type Result } from '../../domain/result.js';
import { freezeJson, isJsonObject } from '../../domain/json-document.js';
import { applicationError, type ApplicationError } from '../../application/authorization.js';
import type {
  JudgementProvider,
  JudgementRequest,
  JudgementResponse,
  ProposalProvider,
  ProposalRequest,
  ProposalResponse,
} from '../../application/ports.js';
import { canonicalJson } from '../../domain/canonical-json.js';

/**
 * The recorded adapter (ADR-0024): an in-process replay of request/response
 * pairs from committed files, chosen over a fixture service. It keeps every
 * testing benefit of one — a real provider-shaped seam, answers a test can
 * predict — with no container, no port and no second runtime.
 *
 * **It answers from the recordings and from nothing else.**
 *
 * - A request with no recording fails loudly, as a typed error naming the
 *   request's key so the missing recording is easy to add. It never falls back
 *   to a live call, and never invents a response: a test passing on an invented
 *   answer would be a test of this file.
 * - It holds no credential and reads none. There is nothing here that could
 *   make a network call, and the fitness rules say so (EXT-05).
 * - It is deterministic: the response is a pure function of the request and of
 *   the files, so the same request yields the same bytes on any machine.
 *
 * **What identifies a request.** The model version, the prompt version, the
 * grounding and the task — the question being asked. *Not* the run id: that
 * names this invocation, not the question, and keying on it would mean no
 * recording could ever match a fresh run.
 */

/** A recording that cannot be trusted is a load-time failure, not a surprise at replay. */
export class InvalidRecordingError extends Error {
  constructor(source: string, reason: string) {
    super(`recording ${source} is not usable: ${reason}`);
    this.name = 'InvalidRecordingError';
  }
}

interface RecordedRequest {
  readonly pin: { readonly modelVersionId: string; readonly promptVersionId: string };
  readonly grounding: ProposalRequest['grounding'];
  readonly task: ProposalRequest['task'];
}

/** The part of a proposal request that identifies the question — see the note above. */
function proposalKey(request: RecordedRequest): string {
  return canonicalJson({
    modelVersionId: request.pin.modelVersionId,
    promptVersionId: request.pin.promptVersionId,
    grounding: request.grounding,
    task: request.task,
  });
}

/**
 * A judgement is identified by the model, the prompt and the input it was shown.
 * The prompt is part of the key on purpose: the same input put to a different
 * prompt is a different question, which is exactly how a verification differs
 * from the generation it checks (F29).
 */
function judgementKey(request: JudgementRequest): string {
  return canonicalJson({
    modelVersionId: request.modelVersionId,
    promptVersionId: request.promptVersionId,
    input: request.input,
  });
}

function digestOf(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

type Parsed =
  | { readonly kind: 'propose'; readonly key: string; readonly response: ProposalResponse }
  | { readonly kind: 'judge'; readonly key: string; readonly response: JudgementResponse };

function parseProposal(source: string, request: Record<string, unknown>, response: Record<string, unknown>): Parsed {
  const pin = request['pin'];
  if (!isJsonObject(pin) || !nonBlank(pin['modelVersionId']) || !nonBlank(pin['promptVersionId'])) {
    throw new InvalidRecordingError(source, 'request.pin must name a modelVersionId and a promptVersionId');
  }
  if (!Array.isArray(request['grounding']) || !isJsonObject(request['task'])) {
    throw new InvalidRecordingError(source, 'request needs a "grounding" array and a "task" object');
  }
  if (!nonBlank(response['itemType']) || !isJsonObject(response['body'])) {
    throw new InvalidRecordingError(source, 'response needs an "itemType" and a "body" object');
  }
  const confidence = response['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new InvalidRecordingError(source, 'response.confidence must be a number in [0, 1]');
  }
  return {
    kind: 'propose',
    key: proposalKey(request as unknown as RecordedRequest),
    response: freezeJson({ itemType: response['itemType'], body: response['body'], confidence }) as ProposalResponse,
  };
}

function parseJudgement(source: string, request: Record<string, unknown>, response: Record<string, unknown>): Parsed {
  if (!nonBlank(request['modelVersionId']) || !nonBlank(request['promptVersionId']) || !isJsonObject(request['input'])) {
    throw new InvalidRecordingError(source, 'a judgement request needs a modelVersionId, a promptVersionId and an "input" object');
  }
  if (!isJsonObject(response['output'])) {
    throw new InvalidRecordingError(source, 'a judgement response needs an "output" object');
  }
  return {
    kind: 'judge',
    key: judgementKey(request as unknown as JudgementRequest),
    response: freezeJson({ output: response['output'] }) as JudgementResponse,
  };
}

/** A recording is a proposal unless it says `"kind": "judge"`; any other kind is refused, not guessed at. */
function parseRecording(source: string, raw: unknown): Parsed {
  if (!isJsonObject(raw) || !isJsonObject(raw['request']) || !isJsonObject(raw['response'])) {
    throw new InvalidRecordingError(source, 'it must hold a "request" object and a "response" object');
  }
  const kind = raw['kind'] ?? 'propose';
  if (kind === 'propose') return parseProposal(source, raw['request'], raw['response']);
  if (kind === 'judge') return parseJudgement(source, raw['request'], raw['response']);
  throw new InvalidRecordingError(source, `its kind "${String(kind)}" is neither "propose" nor "judge"`);
}

function missingRecording(origin: string, key: string, what: string): ApplicationError {
  return applicationError(
    'PreconditionFailed',
    'NO_RECORDING_FOR_REQUEST',
    `no recording matches this ${what} (key ${digestOf(key)}); add one to ${origin} — the recorded adapter never calls a live provider or invents an answer`,
    'request',
    { requestKey: digestOf(key) },
  );
}

export class RecordedProvider implements ProposalProvider, JudgementProvider {
  readonly #proposals: ReadonlyMap<string, ProposalResponse>;
  readonly #judgements: ReadonlyMap<string, JudgementResponse>;
  readonly #origin: string;

  private constructor(
    proposals: ReadonlyMap<string, ProposalResponse>,
    judgements: ReadonlyMap<string, JudgementResponse>,
    origin: string,
  ) {
    this.#proposals = proposals;
    this.#judgements = judgements;
    this.#origin = origin;
  }

  /** Builds from already-parsed recordings. Throws on any that is unusable, or that repeats a request. */
  static fromRecordings(recordings: readonly { readonly source: string; readonly content: unknown }[], origin = 'recordings'): RecordedProvider {
    const proposals = new Map<string, ProposalResponse>();
    const judgements = new Map<string, JudgementResponse>();
    const sources = new Map<string, string>();

    for (const { source, content } of recordings) {
      const parsed = parseRecording(source, content);
      const identity = `${parsed.kind}:${parsed.key}`;
      const earlier = sources.get(identity);
      if (earlier !== undefined) {
        throw new InvalidRecordingError(source, `it records the same request as ${earlier}; one answer per question`);
      }
      sources.set(identity, source);
      if (parsed.kind === 'propose') proposals.set(parsed.key, parsed.response);
      else judgements.set(parsed.key, parsed.response);
    }
    if (sources.size === 0) {
      throw new InvalidRecordingError(origin, 'there are no recordings, so every request would fail');
    }
    return new RecordedProvider(proposals, judgements, origin);
  }

  /** Reads every `*.json` in a directory, in name order. */
  static fromDirectory(directory: string): RecordedProvider {
    const recordings = readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => {
        const text = readFileSync(join(directory, name), 'utf8');
        try {
          return { source: name, content: JSON.parse(text) as unknown };
        } catch {
          throw new InvalidRecordingError(name, 'it is not valid JSON');
        }
      });
    return RecordedProvider.fromRecordings(recordings, directory);
  }

  async propose(request: ProposalRequest): Promise<Result<ProposalResponse, ApplicationError>> {
    const key = proposalKey(request);
    const recorded = this.#proposals.get(key);
    return recorded === undefined ? err(missingRecording(this.#origin, key, 'proposal request')) : ok(recorded);
  }

  async judge(request: JudgementRequest): Promise<Result<JudgementResponse, ApplicationError>> {
    const key = judgementKey(request);
    const recorded = this.#judgements.get(key);
    return recorded === undefined ? err(missingRecording(this.#origin, key, 'judgement request')) : ok(recorded);
  }
}
