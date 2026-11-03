import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type INestApplication,
  type OnModuleDestroy,
  type Provider,
} from '@nestjs/common';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { AppConfig } from '../config/config.js';
import { createPool } from '../persistence/pool.js';
import { SystemClock, type Clock } from '../persistence/clock.js';
import { UuidIdentifierFactory, type IdentifierFactory } from '../persistence/identifiers.js';
import { PostgresAuditRecorder, type AuditRecorderLike } from '../persistence/audit-recorder.js';
import { BoundedWork } from '../concurrency/bounded-work.js';
import { systemTimers } from '../scheduling/system-timers.js';
import { PostgresRateLimiter } from '../persistence/postgres-rate-limiter.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';
import { PostgresIdempotencyStore, type IdempotencyStore } from '../persistence/idempotency-store.js';
import { createMediaStore, type MediaStore } from '../persistence/filesystem-media-store.js';
import type { PrincipalResolver } from '../auth/principal-resolver.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { AnalyticsEdge } from '../analytics/edge.js';
import { ServerEmitter } from '../analytics/server-emitter.js';
import { LocalDirectorySink, MemorySink, type AnalyticsSink } from '../analytics/sink.js';
import { createLogger } from '../observability/logger.js';
import { defaultMail, identityPrincipals, register as registerIdentity, type BreachedPasswords, type MailPort, type PasswordHasher } from '../../contexts/identity/public/composition.js';
import { createJsonTelemetry, type Telemetry } from '../observability/telemetry.js';
import { instrumentPool } from '../observability/instrumented-pool.js';
import { TelemetryInterceptor } from '../observability/telemetry.interceptor.js';
import { HealthModule } from '../http/health.module.js';
import { contentForAssessment, contentForGeneration, contentForLearning, contentJobs, register as registerContent } from '../../contexts/content/public/composition.js';
import { curriculumForAssessment, curriculumForGeneration, curriculumForLearning, register as registerCurriculum } from '../../contexts/curriculum/public/composition.js';
import { assessmentConsumers, assessmentForLearning, assessmentJobs, register as registerAssessment } from '../../contexts/assessment/public/composition.js';
import { register as registerGeneration, type GenerationCompositionDeps } from '../../contexts/generation/public/composition.js';
import { register as registerScoring, scoringForAssessment, scoringForLearning } from '../../contexts/scoring/public/composition.js';
import { learningForAssessment, learningForRelay, register as registerLearning } from '../../contexts/learning/public/composition.js';
import { OutboxRelay, DEFAULT_RELAY_POLICY, type OutboxConsumer, type RelayPolicy } from '../outbox/relay.js';
import { LearningAttemptScoredConsumer, LearningDiagnosticReportConsumer } from './learning-consumer.js';
import { ScoredAttemptEvidenceSource } from './learning-evidence.js';
import { CurriculumLearnerSource } from './learning-curriculum.js';
import { ContentItemStandings } from './learning-standing.js';
import { Scheduler } from '../scheduling/scheduler.js';
import { BACKGROUND, type Background } from './background.js';

/**
 * The composition root (M0-12, DEC-M0-5). `createApplication` is the single
 * function that turns four independently-composable contexts into one
 * running `INestApplication` — it **wires, and decides nothing**: every
 * default below is a platform adapter this milestone already built (M0-02
 * through M0-11), never a business rule. If wiring something here required a
 * decision, the port supplying it would be the wrong port — see ADR-0017 for
 * the one case that turned out to be true this milestone, fixed before this
 * file was written rather than papered over here.
 *
 * **`platform/composition/` imports only `contexts/*\/public/composition.js`
 * — nothing deeper.** That is F1's extension to `platform/` (DEC-M0-5
 * condition 2, asserted in `app-factory.spec.ts` against a planted deep
 * import, and by the pre-existing `boundary-rules.spec.ts` suite which
 * already walks all of `src`, this file included).
 *
 * **`overrides` exists for tests only.** The production path
 * (`main.ts`, M0-13) calls `createApplication(config)` with no second
 * argument — a unit spec below asserts exactly that.
 */
export interface CreateApplicationOverrides {
  readonly pool?: Pool;
  readonly clock?: Clock;
  readonly identifiers?: IdentifierFactory;
  readonly audit?: AuditRecorderLike;
  readonly mediaStore?: MediaStore;
  readonly idempotency?: IdempotencyStore;
  readonly principals?: PrincipalResolver;
  readonly telemetry?: Telemetry;
  /** Where admitted analytics events go. Absent: a directory beside the media store in a process that runs for real, memory under test (the Parquet sink is M8's, D90). */
  readonly analyticsSink?: AnalyticsSink;
  /** Where identity's verification and recovery messages go. Absent: a directory in development, memory under test, and a refusal in production, where no provider is chosen yet. */
  readonly mail?: MailPort;
  /** Where the authentication routes count (M8-06). Absent: Postgres, so the limit holds across instances. */
  readonly limiter?: RateLimiter;
  /** Where log lines go. Absent: standard output, a line each. A test that reads what the application said passes one. */
  readonly logWrite?: (line: string) => void;
  /** What derives a password hash. Absent: scrypt under today's parameters; a test passes one that counts. It is bounded either way. */
  readonly hasher?: PasswordHasher;
  /** Where a password is looked up before it is accepted (M8-11). Absent: the list that ships with the code. A test passes one that cannot answer. */
  readonly breached?: BreachedPasswords;
  /** Substituted only to prove F11 across the composed set (app-factory.spec.ts) — never in production. */
  readonly contentRegister?: typeof registerContent;
  readonly curriculumRegister?: typeof registerCurriculum;
  readonly scoringRegister?: typeof registerScoring;
  readonly generationRegister?: typeof registerGeneration;
  readonly assessmentRegister?: typeof registerAssessment;
  /** The relay's policy, for a test that wants a message to die in two attempts; production takes the default. */
  readonly relayPolicy?: RelayPolicy;
  /**
   * The provider generation proposes and judges through. Absent in production, where
   * no live adapter exists yet and generation is composed with one that answers
   * every call as unavailable; a test passes the recorded adapter here.
   */
  readonly generationProvider?: GenerationCompositionDeps['provider'];
}

/**
 * Combines the four contexts' `DynamicModule`s into one root module,
 * following the same static-`register` convention every `*.module.ts` in
 * this repository already uses. It declares nothing of its own — no
 * controller, no provider — so there is nothing here for a business rule to
 * hide in.
 */
@Module({})
export class RootModule {
  static register(imports: readonly DynamicModule[], providers: readonly Provider[] = []): DynamicModule {
    return { module: RootModule, imports: [...imports], providers: [...providers] };
  }
}

/**
 * The one provider `RootModule` carries of its own — registered only when
 * `createApplication` built the pool itself (never for a test-supplied
 * one). Nest's `app.close()` already calls `onModuleDestroy` on every
 * provider it manages; a plain reassignment of `app.close` does not work,
 * because `NestFactory.create`'s return value is a Proxy whose `close`
 * always forwards to Nest's own implementation regardless of what an own
 * property is set to — found by reading `app.close.toString()` after the
 * reassignment and seeing Nest's proxy trap, not this file's function.
 */
@Injectable()
class FactoryOwnedPoolCloser implements OnModuleDestroy {
  readonly #pool: Pool;

  constructor(@Inject(Pool) pool: Pool) {
    this.#pool = pool;
  }

  async onModuleDestroy(): Promise<void> {
    await this.#pool.end();
  }
}

export async function createApplication(
  config: AppConfig,
  overrides: CreateApplicationOverrides = {},
): Promise<INestApplication> {
  const telemetry = overrides.telemetry ?? createJsonTelemetry();
  const poolOwnedByFactory = overrides.pool === undefined;
  const pool = instrumentPool(overrides.pool ?? createPool({ databaseUrl: config.databaseUrl }), telemetry);
  const clock = overrides.clock ?? new SystemClock();
  const identifiers = overrides.identifiers ?? new UuidIdentifierFactory();
  const audit = overrides.audit ?? new PostgresAuditRecorder(pool);
  const idempotency = overrides.idempotency ?? new PostgresIdempotencyStore(pool);
  const mediaStore =
    overrides.mediaStore ?? createMediaStore({ mediaStorageRoot: config.mediaStorageRoot, nodeEnv: config.nodeEnv });
  const analyticsLog = createLogger({ logLevel: config.logLevel, nodeEnv: config.nodeEnv, ...(overrides.logWrite === undefined ? {} : { write: overrides.logWrite }) });
  // Who a request is: a session, looked up on every request (M8-03). The resolver every context takes is answered from the session table by a middleware installed below.
  // The token stub is not here; a test that wants it passes it as `principals`, and then no middleware is installed and no session is read.
  // identity writes its audit rows in the transaction of the change they record, so it always has the database's recorder: one a test substituted for the other contexts would not be in that transaction
  const identityAudit = new PostgresAuditRecorder(pool);
  const identity = identityPrincipals({ pool, clock, audit: identityAudit, logger: analyticsLog });
  const principals = overrides.principals ?? identity.resolver;
  // The ingestion edge (M7-61): every analytics event is admitted or quarantined here, and a quarantine is logged as it happens (EVENT-TAXONOMY §1 rule 3).
  const analyticsSink = overrides.analyticsSink ?? (config.nodeEnv === 'test' ? new MemorySink() : new LocalDirectorySink(join(config.mediaStorageRoot, '..', 'analytics')));
  const analyticsEdge = new AnalyticsEdge(analyticsSink, () => clock.now(), (entry) =>
    analyticsLog.log({ level: 'warn', message: 'analytics event quarantined', correlationId: 'n/a', context: 'platform.analytics', attributes: { errorCode: entry.reason } }),
  );
  const analytics = new ServerEmitter({ edge: analyticsEdge, appVersion: 'api' });

  const contentRegister = overrides.contentRegister ?? registerContent;
  const curriculumRegister = overrides.curriculumRegister ?? registerCurriculum;
  const scoringRegister = overrides.scoringRegister ?? registerScoring;
  const generationRegister = overrides.generationRegister ?? registerGeneration;
  const assessmentRegister = overrides.assessmentRegister ?? registerAssessment;

  const contentDeps = {
    pool,
    mediaStore,
    idempotency,
    clock,
    identifiers,
    audit,
    principals,
    reviewPolicy: {
      warnAfterHours: config.reviewWarnAfterHours,
      escalateAfterHours: config.reviewEscalateAfterHours,
      leaseHours: config.reviewLeaseHours,
      sampleRate: config.reviewSampleRate,
    },
  };
  const curriculumDeps = { pool, clock, identifiers, audit, principals };

  const contentModule = contentRegister(contentDeps);
  const curriculumModule = curriculumRegister(curriculumDeps);
  const scoringModule = scoringRegister({ pool, clock, identifiers, audit, principals });
  // Generation is downstream of content and curriculum (ADR-0025): it receives the
  // handlers they name for it, and nothing flows the other way.
  const generationModule = generationRegister({
    pool,
    clock,
    identifiers,
    audit,
    principals,
    content: contentForGeneration(contentDeps),
    curriculum: curriculumForGeneration(curriculumDeps),
    ...(overrides.generationProvider === undefined ? {} : { provider: overrides.generationProvider }),
    ...(config.generationPrecheckConfig === undefined ? {} : { precheckConfig: config.generationPrecheckConfig }),
  });

  // Assessment is downstream of content, curriculum and scoring too: it receives the handlers each names for it, and nothing flows back.
  const assessmentDeps = {
    pool,
    clock,
    identifiers,
    audit,
    principals,
    content: contentForAssessment(contentDeps),
    curriculum: curriculumForAssessment(curriculumDeps),
    scoring: scoringForAssessment({ pool, clock, identifiers, audit, principals }),
    learning: learningForAssessment({ pool }),
    intervalCapMs: config.timeOnItemIntervalCapMs,
    ...(config.formPackageSigningKey === undefined ? {} : { packageSigningKey: config.formPackageSigningKey }),
  };
  const assessmentModule = assessmentRegister(assessmentDeps);

  // What runs beside the server: the relay that hands outbox messages to their consumers, and the scheduler that drives it and the
  // sweeps. Built here, started by the process (background.ts).
  // Learning is the first consumer of `AttemptScored` (M7-16) and of `AttemptScoreSuperseded`, which says a re-score replaced an attempt's score (M7-40). It reads scoring, content and assessment through the seams each names for it, and the root
  // joins them; learning itself imports none of the three.
  const learningEvidence = new ScoredAttemptEvidenceSource({
    scoring: scoringForLearning({ pool, clock, identifiers, audit, principals }),
    content: contentForLearning(contentDeps),
    assessment: assessmentForLearning({ pool }),
  });
  // The learner's routes read what the same evidence source reads, for the pace of an attempt, and ask content for the standing of a bookmarked item.
  // the authentication routes and the profile routes count in the same table, so a limit means the same from every instance
  const rateCounters = new PostgresRateLimiter(pool, clock.now.bind(clock));
  const learningModule = registerLearning({
    pool,
    clock,
    identifiers,
    principals,
    paceSlots: learningEvidence,
    standings: new ContentItemStandings(contentForLearning(contentDeps)),
    curriculum: new CurriculumLearnerSource(curriculumForLearning(curriculumDeps)),
    limiter: overrides.limiter ?? rateCounters,
    limits: config.rateLimitProfile,
    refusals: analyticsLog,
  });
  const learningForConsumers = learningForRelay({ pool, clock, identifiers });
  const learningConsumer = new LearningAttemptScoredConsumer({ evidence: learningEvidence, learning: learningForConsumers, analytics });
  // the report is made after the evidence is recorded, by the same delivery (M7-42)
  const reportConsumer = new LearningDiagnosticReportConsumer({ slots: learningEvidence, learning: learningForConsumers });
  const consumers = new Map<string, readonly OutboxConsumer[]>([
    ...assessmentConsumers(assessmentDeps),
    ['AttemptScored', [learningConsumer, reportConsumer]],
    ['AttemptScoreSuperseded', [learningConsumer, reportConsumer]],
  ]);
  const relay = new OutboxRelay(pool, consumers, overrides.relayPolicy ?? DEFAULT_RELAY_POLICY);
  const scheduler = new Scheduler([
    { name: 'outbox.drain', everyMs: 1_000, run: async (now) => void (await relay.drain(now)) },
    { name: 'rate-counters.reap', everyMs: 600_000, run: async (now) => void (await rateCounters.reapExpired(now)) },
    ...assessmentJobs(assessmentDeps),
    ...contentJobs(contentDeps),
  ]);
  const background: Background = { relay, scheduler };

  const identityModule = registerIdentity({
    pool,
    clock,
    identifiers,
    audit: identityAudit,
    principals,
    maxSessionsPerUser: config.maxSessionsPerUser,
    limiter: overrides.limiter ?? rateCounters,
    limits: {
      login: config.rateLimitLogin,
      register: config.rateLimitRegister,
      recovery: config.rateLimitRecovery,
      reset: config.rateLimitReset,
      verification: config.rateLimitVerification,
      passwordChange: config.rateLimitPasswordChange,
    },
    hashBound: new BoundedWork({ concurrency: config.passwordHashConcurrency, queueLimit: config.passwordHashQueue, waitMs: config.passwordHashWaitMs, timers: systemTimers }),
    refusals: analyticsLog,
    ...(overrides.hasher === undefined ? {} : { hasher: overrides.hasher }),
    ...(overrides.breached === undefined ? {} : { breached: overrides.breached }),
    mail: overrides.mail ?? defaultMail({ nodeEnv: config.nodeEnv, directory: join(config.mediaStorageRoot, '..', 'mail'), now: clock.now.bind(clock) }),
  });
  const rootImports = [identityModule, AnalyticsModule.register({ edge: analyticsEdge, principals }), contentModule, curriculumModule, scoringModule, generationModule, assessmentModule, learningModule, HealthModule.register(pool)];
  // The pool this factory itself built is this factory's to close — a pool
  // a test supplied through `overrides.pool` stays that test's to close, so
  // `app.close()` never double-closes a connection the caller still owns
  // (pool.ts: "`close` is what main.ts's graceful shutdown calls").
  const rootProviders: Provider[] = [{ provide: BACKGROUND, useValue: background }, ...(poolOwnedByFactory ? [FactoryOwnedPoolCloser, { provide: Pool, useValue: pool }] : [])];

  const app = await NestFactory.create(RootModule.register(rootImports, rootProviders), { logger: false });
  // Behind a proxy a client's address is the proxy's unless the application is told how many to believe; every client would then be one source (M8-07).
  if (config.trustProxyHops > 0) app.getHttpAdapter().getInstance().set('trust proxy', config.trustProxyHops);
  if (overrides.principals === undefined) app.use(identity.middleware);
  app.useGlobalInterceptors(new TelemetryInterceptor(telemetry));

  return app;
}
