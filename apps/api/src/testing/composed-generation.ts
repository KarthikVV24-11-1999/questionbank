import type { INestApplication } from '@nestjs/common';
import type { Clock, IdentifierFactory } from '../contexts/generation/application/ports.js';
import type { HandlerRegistry } from '../contexts/generation/application/handler-registry.js';
import type { PrecheckConfig } from '../contexts/generation/application/prechecks/judge.js';
import { GENERATION_REGISTRY } from '../contexts/generation/api/generation.controller.js';
import type { GenerationCompositionDeps } from '../contexts/generation/public/composition.js';
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
  const registry = app.get<HandlerRegistry>(GENERATION_REGISTRY, { strict: false });
  return { app, registry, close: () => app.close() };
}
