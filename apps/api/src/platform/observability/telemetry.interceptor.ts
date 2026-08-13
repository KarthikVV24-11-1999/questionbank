import { randomUUID } from 'node:crypto';
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { Telemetry } from './telemetry.js';

interface TelemetryRequest {
  readonly method: string;
  readonly path: string;
  readonly route?: { readonly path?: string };
  readonly headers: Record<string, string | readonly string[] | undefined>;
}

function firstHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : (value as string | undefined);
}

/**
 * The one place a request becomes a span tree (DEC-M0-10, M0-14). No context
 * file changes to get it: this interceptor sits entirely in `platform/`,
 * wired once in `createApplication` (M0-12) via `app.useGlobalInterceptors`,
 * and wraps whatever the matched controller method does — including its own
 * call into `runOperation` and the application handler underneath it —
 * without either needing to know this interceptor exists.
 *
 * **Root span** is named for the route (`GET /v1/items/:itemId`, the
 * *template*, not the resolved id — no request parameter ever becomes a span
 * name or attribute, so a span cannot leak what content.controller.ts's own
 * request accidentally could). **Child span** is named for the matched
 * handler method (`getPublishedItem`) — the unit of work each controller
 * method already is, one to one with the application handler it calls
 * (`runOperation`'s own `handlerName` argument, e.g. `GetPublishedItem`,
 * stays internal to the context and is not read here, which is exactly what
 * keeps this file out of `contexts/*`). A database call nested under either
 * becomes a further child through `instrumented-pool.ts`'s own span, by the
 * same parent-linkage mechanism.
 *
 * **The correlation id is decided here, once, before the controller method
 * runs**, and written back onto the request's own headers — the same object
 * `http-runner.ts`'s `@Headers()` decorator reads — so its echo onto the
 * response (`X-Correlation-Id`) is always the same id every span in the tree
 * carries as its `traceId`.
 */
@Injectable()
export class TelemetryInterceptor implements NestInterceptor {
  readonly #telemetry: Telemetry;

  constructor(telemetry: Telemetry) {
    this.#telemetry = telemetry;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<TelemetryRequest>();

    const correlationId = firstHeaderValue(request.headers['x-correlation-id']) ?? randomUUID();
    (request.headers as Record<string, string>)['x-correlation-id'] = correlationId;

    const route = `${request.method} ${request.route?.path ?? request.path}`;
    const handlerName = context.getHandler().name;

    return from(
      this.#telemetry.withSpan(route, { correlationId }, () =>
        this.#telemetry.withSpan(handlerName, { correlationId }, () =>
          lastValueFrom(next.handle(), { defaultValue: undefined }),
        ),
      ),
    );
  }
}
