import type { INestApplication } from '@nestjs/common';
import type { Clock, IdentifierFactory } from '../contexts/generation/application/ports.js';
import type { HandlerRegistry } from '../contexts/generation/application/handler-registry.js';
import type { PrecheckConfig } from '../contexts/generation/application/prechecks/judge.js';
import { GENERATION_REGISTRY } from '../contexts/generation/api/generation.controller.js';
import type { GenerationCompositionDeps } from '../contexts/generation/public/composition.js';
import { createAIBudget } from '../contexts/generation/domain/ai-budget.js';
import { PostgresAIBudgetRepository } from '../contexts/generation/infrastructure/ai-budget.repository.js';
import { periodOf } from '../contexts/generation/domain/ai-budget.js';
import { ensureVersions } from './generation-fixtures.js';
import { createApplication } from '../platform/composition/app-factory.js';
import type { AppConfig } from '../platform/config/config.js';
import { createRecordingTelemetry } from '../platform/observability/recording-telemetry.js';
import type { TestDatabase } from './database.js';
import { fixedClock, uuidFactory } from './generation-context.js';

/**
 * Generation as the application composes it: `createApplication`, over a test
 * database, with the real content and curriculum handlers behind it and the real
 * audit recorder in front. This is the only way a spec gets a generation registry —
 * the pieces are never assembled by hand beside the composition root, because a
 * hand-assembled registry proves the pieces fit the way the test fitted them.
 *
 * What a spec may vary is what the root itself lets a deployment or a test vary:
 * the provider (no live adapter exists, so a spec passes the recorded one), the
 * pre-check configuration, the clock and the identifiers.
 */
const CONFIG: AppConfig = {
  databaseUrl: 'unused-because-pool-is-overridden',
  port: 3000,
  nodeEnv: 'test',
  authSigningKey: 'a'.repeat(32),
  auditAnchorKey: 'b'.repeat(32),
  authIssuer: 'questionbank',
  authTokenTtlSeconds: 3600,
  mediaStorageRoot: './var/media-test',
  logLevel: 'info',
  reviewWarnAfterHours: 48,
  reviewEscalateAfterHours: 72,
  reviewLeaseHours: 4,
  reviewSampleRate: 0.05,
};

export interface ComposedGeneration {
  readonly app: INestApplication;
  readonly registry: HandlerRegistry;
  close(): Promise<void>;
}

export interface ComposeOptions {
  readonly provider?: GenerationCompositionDeps['provider'];
  readonly precheckConfig?: PrecheckConfig;
  readonly clock?: Clock;
  readonly identifiers?: IdentifierFactory;
  /**
   * The ceiling declared for the clock's month, in tokens. Generous by default so a spec that is
   * not about budgets is not limited by one; `null` declares none, which is what a deployment has
   * until someone declares one.
   */
  readonly budgetCeilingTokens?: number | null;
}

export async function composeGeneration(database: TestDatabase, options: ComposeOptions = {}): Promise<ComposedGeneration> {
  const app = await createApplication(
    { ...CONFIG, ...(options.precheckConfig === undefined ? {} : { generationPrecheckConfig: options.precheckConfig }) },
    {
      pool: database.pool,
      telemetry: createRecordingTelemetry(),
      clock: options.clock ?? fixedClock,
      identifiers: options.identifiers ?? uuidFactory,
      ...(options.provider === undefined ? {} : { generationProvider: options.provider }),
    },
  );
  // A judged check's spend is attributed to the model and prompt version it ran under, as foreign keys into
  // the registry, so the versions a configuration names have to be rows before anything is spent against them.
  for (const pin of Object.values(options.precheckConfig ?? {})) await ensureVersions(database.pool, pin);
  const ceiling = options.budgetCeilingTokens === undefined ? 1_000_000_000 : options.budgetCeilingTokens;
  if (ceiling !== null) {
    const clock = options.clock ?? fixedClock;
    const budget = createAIBudget({ feature: 'generation', period: periodOf(clock.now().toISOString())!, ceilingTokens: ceiling });
    if (!budget.ok) throw new Error(`the composed budget is invalid: ${budget.error.code}`);
    // Already declared by an earlier composition over the same database is fine: a period's ceiling is fixed once.
    await new PostgresAIBudgetRepository(database.pool).declare(budget.value, { kind: 'human', id: '00000000-0000-4000-8000-00000000b0b0' }, clock.now().toISOString());
  }
  const registry = app.get<HandlerRegistry>(GENERATION_REGISTRY, { strict: false });
  return { app, registry, close: () => app.close() };
}
