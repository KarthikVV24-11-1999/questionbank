import { createClient, type ApiClient } from '@questionbank/contracts/client';
import { diagnosticRunBody, practiceRunBody } from '@questionbank/contracts/practice-request';
import { attemptSchema, attemptWithLogSchema, createdAttemptSchema, ingestReportSchema, practiceFeedbackSchema, resultSchema, signingKeySchema, type AttemptDto, type ResultDto, type Verdict } from './schemas.js';
import type { AttemptTransport } from '../session/ports.js';
import type { PackageResponse, SigningKey } from '../package/load.js';

/**
 * The learner app's whole conversation with the server, through the one typed client (F15). Nothing here calls `fetch`; the client
 * parses every JSON response through a schema, and keeps a package's bytes exactly as sent.
 */
export interface AssessmentApi extends AttemptTransport {
  createAttempt(formId: string, sessionRef: string, idempotencyKey: string): Promise<AttemptDto>;
  startAttempt(attemptId: string): Promise<AttemptDto>;
  /** A practice run about the given concepts (M7-58). The key makes a retried tap return the run it already made. */
  createPracticeAttempt(request: PracticeRequest, idempotencyKey: string): Promise<AttemptDto>;
  /** The diagnostic (M8-32): the same practice-run route, with the breadth strategy and the learner's declared scope. */
  createDiagnosticAttempt(request: DiagnosticRequest, idempotencyKey: string): Promise<AttemptDto>;
  /** What the server says of one answered slot of a practice run: a word and nothing more (M8-33). */
  getPracticeFeedback(attemptId: string, slotId: string): Promise<Verdict>;
  /** Adds questions to a practice run in progress (M8-33); the run's package changes, and the caller fetches the new one. */
  growPracticeAttempt(attemptId: string, count: number): Promise<AttemptDto>;
  getPackage(formId: string): Promise<PackageResponse>;
  /** The package of one practice run: the caller's own, signed (M8-23). */
  getPracticePackage(attemptId: string): Promise<PackageResponse>;
  getSigningKey(): Promise<SigningKey>;
}

export interface PracticeRequest {
  readonly examProfileVersionId: string;
  readonly conceptIdentityIds: readonly string[];
  readonly count: number;
}

export interface DiagnosticRequest {
  readonly examProfileVersionId: string;
  readonly count: number;
}

export function createAssessmentApi(client: ApiClient): AssessmentApi {
  const attempt = (id: string, suffix = '') => `/v1/assessment/attempts/${encodeURIComponent(id)}${suffix}`;
  return {
    createAttempt: async (formId, sessionRef, idempotencyKey) =>
      (await client.request({ method: 'POST', path: '/v1/assessment/attempts', body: { formId, sessionRef }, headers: { 'Idempotency-Key': idempotencyKey }, responseSchema: createdAttemptSchema })).attempt,
    createPracticeAttempt: async (request, idempotencyKey) =>
      (
        await client.request({
          method: 'POST',
          path: '/v1/assessment/practice-attempts',
          body: practiceRunBody({ examProfileVersionId: request.examProfileVersionId, conceptIdentityIds: request.conceptIdentityIds, count: request.count }),
          headers: { 'Idempotency-Key': idempotencyKey },
          responseSchema: createdAttemptSchema,
        })
      ).attempt,
    createDiagnosticAttempt: async (request, idempotencyKey) =>
      (
        await client.request({
          method: 'POST',
          path: '/v1/assessment/practice-attempts',
          body: diagnosticRunBody(request),
          headers: { 'Idempotency-Key': idempotencyKey },
          responseSchema: createdAttemptSchema,
        })
      ).attempt,
    getPracticeFeedback: async (attemptId, slotId) =>
      (await client.request({ path: attempt(attemptId, `/slots/${encodeURIComponent(slotId)}/feedback`), responseSchema: practiceFeedbackSchema })).outcome,
    growPracticeAttempt: (attemptId, count) => client.request({ method: 'POST', path: attempt(attemptId, '/practice-items'), body: { count }, responseSchema: attemptSchema }),
    startAttempt: (attemptId) => client.request({ method: 'POST', path: attempt(attemptId, '/start'), responseSchema: attemptSchema }),
    getAttempt: (attemptId) => client.request({ path: attempt(attemptId), responseSchema: attemptWithLogSchema }),
    sendEvents: async (attemptId, deviceRef, events) => {
      const report = await client.request({ method: 'POST', path: attempt(attemptId, '/events'), body: { deviceRef, events }, responseSchema: ingestReportSchema });
      return { acknowledged: report.acknowledged, rejected: report.results.filter((result) => result.outcome === 'rejected').map((result) => result.eventId) };
    },
    submit: (attemptId, reason, idempotencyKey) =>
      client.request({ method: 'POST', path: attempt(attemptId, '/submission'), body: { reason }, headers: { 'Idempotency-Key': idempotencyKey }, responseSchema: attemptSchema }),
    getResult: (attemptId): Promise<ResultDto> => client.request({ path: attempt(attemptId, '/result'), responseSchema: resultSchema }),
    getPackage: async (formId) => {
      const { bytes, headers } = await client.requestBytes({ path: `/v1/assessment/forms/${encodeURIComponent(formId)}/package` });
      return { bytes, signature: headers.get('x-package-signature'), digest: headers.get('x-package-digest'), keyId: headers.get('x-package-key-id') };
    },
    getPracticePackage: async (attemptId) => {
      const { bytes, headers } = await client.requestBytes({ path: `/v1/assessment/practice-attempts/${encodeURIComponent(attemptId)}/package` });
      return { bytes, signature: headers.get('x-package-signature'), digest: headers.get('x-package-digest'), keyId: headers.get('x-package-key-id') };
    },
    getSigningKey: async () => {
      const key = await client.request({ path: '/v1/assessment/package-signing-key', responseSchema: signingKeySchema });
      return { keyId: key.keyId, publicKey: key.publicKey };
    },
  };
}
