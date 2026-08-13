import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Pool } from 'pg';

export const HEALTH_POOL = Symbol('HEALTH_POOL');

/**
 * Two different questions, on purpose (M0-13). **Liveness** (`/healthz`)
 * answers "is the process up", touching nothing — a database outage must
 * never take the process itself out of a load balancer's rotation, or a
 * transient blip becomes a restart storm. **Readiness** (`/readyz`) answers
 * "can this instance serve a request right now", which for this application
 * means the database is reachable — Compose's own `depends_on: { condition:
 * service_healthy }` (DEC-M0-9) depends on exactly this difference existing
 * as two routes, not one.
 *
 * Neither is authenticated, and neither is contract — both are asserted
 * absent from every OpenAPI document (`health.controller.spec.ts`), since an
 * operational probe is not a versioned API surface.
 */
@Controller()
export class HealthController {
  readonly #pool: Pool;

  constructor(@Inject(HEALTH_POOL) pool: Pool) {
    this.#pool = pool;
  }

  @Get('/healthz')
  healthz(@Res() response: Response): void {
    response.status(200).json({ status: 'ok' });
  }

  @Get('/readyz')
  async readyz(@Res() response: Response): Promise<void> {
    try {
      await this.#pool.query('SELECT 1');
      response.status(200).json({ status: 'ok' });
    } catch (error) {
      response.status(503).json({
        status: 'unavailable',
        reason: error instanceof Error ? error.message : 'database unreachable',
      });
    }
  }
}
