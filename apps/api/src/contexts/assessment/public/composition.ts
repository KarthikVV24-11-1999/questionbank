import type { Pool } from 'pg';
import { ROLES } from '../../../platform/auth/roles.js';
import type { DynamicModule } from '@nestjs/common';
import type { PrincipalResolver } from '../api/assessment.controller.js';
import { AssessmentModule } from '../api/assessment.module.js';
import { composeAssessmentHandlers } from '../application/compose-handlers.js';
import type { AuditRecorder, Clock, IdentifierFactory } from '../application/ports.js';
import { PostgresAnchorPoolRepository } from '../infrastructure/anchor-pool.repository.js';
import { PostgresAttemptRepository } from '../infrastructure/attempt.repository.js';
import { ContentCorpus, type CatalogueHandler, type DuplicatesHandler } from '../infrastructure/content-corpus.js';
import { CurriculumPinSource, type ProfilePinsHandler } from '../infrastructure/curriculum-pin-source.js';
import { LearningRemediationSource, type RemediationConceptsHandler } from '../infrastructure/learning-remediation-source.js';
import { ScoringResponseJudge, type SlotJudge } from '../infrastructure/scoring-response-judge.js';
import { ContentFormReader } from '../infrastructure/content-form-reader.js';
import { PostgresExposureLedger } from '../infrastructure/exposure-ledger.repository.js';
import { PostgresFormRepository } from '../infrastructure/form.repository.js';
import { Ed25519PackageSigner } from '../infrastructure/package-signer.js';
import { PostgresSolutionReleases } from '../infrastructure/solution-release.repository.js';
import { ContentSolutionReader } from '../infrastructure/content-solution-reader.js';
import { PostgresResponseLog } from '../infrastructure/response-log.repository.js';
import { ScoreSubmittedAttemptConsumer, type ScoringKeyReader, type ScoringSpecReader, type Scorer } from '../application/consumers/scoring-consumer.js';
import type { ScoreRecordReader } from '../application/handlers/attempt-handlers.js';
import { SubmitExpiredAttemptsHandler } from '../application/handlers/expiry-handler.js';
import { GetResponseTimingsHandler } from '../application/handlers/response-timing-handler.js';
import { SweepWindowsHandler } from '../application/handlers/sweep-handler.js';
import type { ApplicationContext } from '../application/ports.js';

/**
 * The composition seam (DEC-M0-5, ADR-0015). `register` builds assessment's
 * repositories, its adapter over content, and its handlers, and returns the module
 * that carries them.
 *
 * **Assessment holds no content code.** What it calls in content arrives in `deps`
 * as the two handlers content chose to hand over (`contentForAssessment`, in
 * content's own seam), declared here by the shape assessment needs of them and
 * nothing else. The root passes one context's output to the other's input and
 * decides nothing — which is why no assessment file imports anything from content.
 */
export interface AssessmentCompositionDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
  readonly principals: PrincipalResolver;
  /** The one configured cap on a visit's time on item; pinned onto each attempt (M6-37). */
  readonly intervalCapMs: number;
  /**
   * The Ed25519 seed packages are signed with (M6-26), base64. Absent, and the
   * package routes answer as unavailable rather than serving bytes nothing vouches for.
   */
  readonly packageSigningKey?: string;
  /** Curriculum's one read assessment makes — `curriculumForAssessment`, passed through. */
  readonly curriculum: { readonly examProfilePins: ProfilePinsHandler; readonly scoringSpec: ScoringSpecReader };
  /** Scoring's two handlers assessment uses — scoring's `scoringForAssessment`, passed through (M6-40). */
  readonly scoring: { readonly scoreAttempt: Scorer; readonly scoreRecord: ScoreRecordReader; readonly judge: SlotJudge };
  /**
   * Learning's one answer assessment asks for — `learningForAssessment`, passed through (M7-28): the concepts a targeted run should be about. Optional,
   * so a deployment without Learning still serves filtered practice and says plainly that targeted practice is not available.
   */
  readonly learning?: { readonly remediationConcepts: RemediationConceptsHandler };
  /** Content's handlers assessment may call — content's `contentForAssessment`, passed through. */
  readonly content: {
    readonly listCatalogue: CatalogueHandler;
    readonly duplicates: DuplicatesHandler;
    readonly itemVersion: ConstructorParameters<typeof ContentFormReader>[0]['itemVersion'];
    readonly stimulusVersion: ConstructorParameters<typeof ContentFormReader>[0]['stimulusVersion'];
    /** The keys of pinned versions, for scoring and for nothing else (M6-40). */
    readonly answerKeys: ScoringKeyReader;
    /** A published solution, for a slot the effort gate has released (M7-37): the learner's own, and reached only through a `ReleasedSlot`. */
    readonly solution: ConstructorParameters<typeof ContentSolutionReader>[0]['solution'];
  };
}

const REQUIRED_DEPS_KEYS = ['pool', 'clock', 'identifiers', 'audit', 'principals', 'content', 'curriculum', 'scoring', 'intervalCapMs'] as const satisfies readonly (keyof AssessmentCompositionDeps)[];

function assemble(deps: AssessmentCompositionDeps) {
  return {
    forms: new PostgresFormRepository(deps.pool),
    attempts: new PostgresAttemptRepository(deps.pool),
    responses: new PostgresResponseLog(deps.pool),
    releases: new PostgresSolutionReleases(deps.pool),
    solutions: new ContentSolutionReader({ solution: deps.content.solution }),
    corpus: new ContentCorpus({
      catalogue: deps.content.listCatalogue,
      duplicates: deps.content.duplicates,
      anchors: new PostgresAnchorPoolRepository(deps.pool),
      exposure: new PostgresExposureLedger(deps.pool),
    }),
    content: new ContentFormReader({ itemVersion: deps.content.itemVersion, stimulusVersion: deps.content.stimulusVersion }),
    pins: new CurriculumPinSource(deps.curriculum.examProfilePins),
    practicePins: new CurriculumPinSource(deps.curriculum.examProfilePins),
    ...(deps.learning === undefined ? {} : { remediation: new LearningRemediationSource(deps.learning.remediationConcepts) }),
    scoreRecord: deps.scoring.scoreRecord,
    judge: new ScoringResponseJudge({ keys: deps.content.answerKeys, spec: deps.curriculum.scoringSpec, judge: deps.scoring.judge }),
    intervalCapMs: deps.intervalCapMs,
    clock: deps.clock,
    identifiers: deps.identifiers,
    audit: deps.audit,
    signer: deps.packageSigningKey === undefined ? undefined : new Ed25519PackageSigner(deps.packageSigningKey),
  };
}

function checkDeps(deps: AssessmentCompositionDeps): void {
  for (const key of REQUIRED_DEPS_KEYS) {
    if (deps[key] === undefined) {
      throw new Error(`assessment composition is missing required dependency: ${key}`);
    }
  }
}

/**
 * What the outbox relay hands assessment's events to (M6-38, M6-40): `AttemptSubmitted` goes to the scoring consumer. Built from the
 * same assembly `register` uses, so the attempt it scores is the attempt the routes wrote.
 */
export function assessmentConsumers(deps: AssessmentCompositionDeps): ReadonlyMap<string, readonly OutboxConsumerLike[]> {
  checkDeps(deps);
  const bag = assemble(deps);
  const scoring = new ScoreSubmittedAttemptConsumer({
    attempts: bag.attempts,
    forms: bag.forms,
    responses: bag.responses,
    keys: deps.content.answerKeys,
    spec: deps.curriculum.scoringSpec,
    scorer: deps.scoring.scoreAttempt,
  });
  return new Map([['AttemptSubmitted', [scoring]]]);
}

/**
 * What the relay and the scheduler are handed, declared here by the shape this context produces: a context reaches `platform/` for the
 * role vocabulary and nothing else (ADR-0026), so it names no platform type, and the root — which owns the relay and the scheduler —
 * receives these structurally.
 */
export interface OutboxConsumerLike {
  readonly name: string;
  handle(envelope: { readonly messageId: string; readonly correlationId: string; readonly payload: Readonly<Record<string, unknown>> }): Promise<void>;
}
export interface BackgroundJobLike {
  readonly name: string;
  readonly everyMs: number;
  run(now: Date): Promise<void>;
}

/** The identity the scheduler's jobs act under: the system's, in the one role their policies name. */
const SCHEDULER_PRINCIPAL_ID = '00000000-0000-4000-8000-0000000000f1';

/**
 * What the scheduler runs for assessment (M6-42, D36): opening and closing form windows and abandoning attempts a closed window left
 * (`SweepWindows`), and submitting the attempts whose deadline passed with no device to say so (`SubmitExpiredAttempts`). Ordinary
 * idempotent commands, run as the system, each taking its moment from the clock; the scheduler decides only when to ask.
 */
export function assessmentJobs(deps: AssessmentCompositionDeps): readonly BackgroundJobLike[] {
  checkDeps(deps);
  const bag = assemble(deps);
  const sweep = new SweepWindowsHandler(bag);
  const expiry = new SubmitExpiredAttemptsHandler(bag);
  const asSystem = (name: string): ApplicationContext => ({
    principal: { kind: 'system', id: SCHEDULER_PRINCIPAL_ID, roleContext: [ROLES.system] },
    correlationId: `scheduler:${name}`,
  });
  const failing = (name: string, error: { readonly code: string; readonly message: string }): never => {
    throw new Error(`${name}: ${error.code}: ${error.message}`);
  };
  return [
    {
      name: 'assessment.sweep-windows',
      everyMs: 30_000,
      run: async () => {
        const done = await sweep.handle({}, asSystem('assessment.sweep-windows'));
        if (!done.ok) failing('SweepWindows', done.error);
      },
    },
    {
      name: 'assessment.submit-expired',
      everyMs: 15_000,
      run: async () => {
        const done = await expiry.handle({}, asSystem('assessment.submit-expired'));
        if (!done.ok) failing('SubmitExpiredAttempts', done.error);
      },
    },
  ];
}

export function register(deps: AssessmentCompositionDeps): DynamicModule {
  checkDeps(deps);

  const registry = composeAssessmentHandlers(assemble(deps));

  return AssessmentModule.register({ registry, principals: deps.principals });
}

/**
 * What the learning context consumes from assessment (M7-11, DEC-M7-1): for a submitted attempt, per slot, the instant of the response that
 * stands and the time on item — and nothing more. Mastery is measured on the instant of the response, and the one place it is recorded is the
 * response log; scoring has an instant of its own, which is the same for every slot of an attempt. Adding a second handler here is a deliberate
 * change to what Learning may ask of assessment, and is reviewed as one.
 */
export interface AssessmentForLearning {
  readonly responseTimings: GetResponseTimingsHandler;
}

export function assessmentForLearning(deps: Pick<AssessmentCompositionDeps, 'pool'>): AssessmentForLearning {
  if (deps.pool === undefined) {
    throw new Error('assessment composition is missing required dependency: pool');
  }
  return {
    responseTimings: new GetResponseTimingsHandler({
      attempts: new PostgresAttemptRepository(deps.pool),
      responses: new PostgresResponseLog(deps.pool),
    }),
  };
}
