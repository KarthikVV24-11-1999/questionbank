import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { MetricsRegistry } from '../observability/metrics.js';

export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');

/**
 * `GET /metrics` (M8-53): the metrics page, in the text exposition format. Like `/healthz` it is operational and not contract, and it is **not authenticated**: what keeps it from the
 * public is where it is published and what is in front of it. The API listens on the loopback address in the Compose file (D123), and the learner app's proxy passes `/v1/` and nothing
 * else (`proxy-rules.ts` fails the `fitness` job if a `proxy_pass` is added outside it). A deployment that puts this port on a network a scraper reads should put authentication in
 * front of it first.
 */
@Controller()
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: MetricsRegistry) {}

  @Get('/metrics')
  async metrics(@Res() response: Response): Promise<void> {
    response.status(200).type('text/plain; version=0.0.4; charset=utf-8').setHeader('Cache-Control', 'no-store');
    response.send(await this.registry.render());
  }
}
