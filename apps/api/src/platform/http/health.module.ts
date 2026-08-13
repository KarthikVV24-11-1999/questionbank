import { Module, type DynamicModule } from '@nestjs/common';
import type { Pool } from 'pg';
import { HealthController, HEALTH_POOL } from './health.controller.js';

/**
 * The same static-`register` shape every module in this repository already
 * uses — wiring only, one provider (the pool `/readyz` probes), no policy,
 * because these two routes carry none (M0-13).
 */
@Module({})
export class HealthModule {
  static register(pool: Pool): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [{ provide: HEALTH_POOL, useValue: pool }],
    };
  }
}
