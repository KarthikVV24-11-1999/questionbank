import { randomUUID } from 'node:crypto';
import { Body, Controller, Headers, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { PrincipalResolver } from '../auth/principal-resolver.js';
import type { AnalyticsEdge } from './edge.js';

export const ANALYTICS_EDGE = Symbol('ANALYTICS_EDGE');
export const ANALYTICS_PRINCIPALS = Symbol('ANALYTICS_PRINCIPALS');

/** Events one request may carry. A client holding more sends them in more requests. */
export const MAX_EVENTS_PER_REQUEST = 100;

const problem = (status: number, title: string, correlationId: string) => ({ type: 'about:blank', title, status, correlationId });

/**
 * The HTTP face of the ingestion edge: `POST /v1/analytics/events` with `{ events: [...] }`. The caller must be authenticated (the edge is not for the open
 * internet), and the answer says, per event, what became of it — so a client keeps what was not accepted and a quarantine is something it can see. A request
 * whose events are all admitted, replayed or quarantined is a `202`: quarantining is the edge doing its job, not the request failing. Only an edge that could not
 * write (`503`) asks the client to send again.
 */
@Controller()
export class AnalyticsController {
  constructor(
    @Inject(ANALYTICS_EDGE) private readonly edge: AnalyticsEdge,
    @Inject(ANALYTICS_PRINCIPALS) private readonly principals: PrincipalResolver,
  ) {}

  @Post('/v1/analytics/events')
  async ingest(@Body() body: unknown, @Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    const correlationId = randomUUID();
    response.setHeader('Cache-Control', 'no-store');
    if (this.principals.resolve(headers) === null) {
      response.status(401).type('application/problem+json').json(problem(401, 'Authentication is required.', correlationId));
      return;
    }
    const events = typeof body === 'object' && body !== null ? (body as { events?: unknown }).events : undefined;
    if (!Array.isArray(events) || events.length > MAX_EVENTS_PER_REQUEST) {
      response.status(400).type('application/problem+json').json(problem(400, `Send { events: [...] } with at most ${MAX_EVENTS_PER_REQUEST} events.`, correlationId));
      return;
    }
    const results: Array<{ index: number; outcome: string; reason?: string }> = [];
    for (const [index, event] of events.entries()) {
      const admission = await this.edge.admit(event);
      results.push({ index, outcome: admission.outcome, ...(admission.outcome === 'quarantined' ? { reason: admission.reason } : {}) });
    }
    const unavailable = results.some((result) => result.outcome === 'sink-unavailable');
    response.status(unavailable ? 503 : 202).json({ results });
  }
}
