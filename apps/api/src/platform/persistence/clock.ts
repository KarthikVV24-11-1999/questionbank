/**
 * Content, curriculum and scoring each declare their own `Clock` interface
 * independently (§9 rule 2's argument, applied at the boundary rather than
 * the domain: a shared `Clock` type would be a thread by which one context's
 * application layer reaches into another's). This is the **one production
 * implementation**, structurally compatible with all three — every one of
 * them declares `now(): Date` and nothing else.
 *
 * `SystemClock` is the only place `new Date()` may appear anywhere in the
 * application outside a test. Every instant a handler needs — a version's
 * `createdAt`, a licence's `asOf`, an audit record's `occurredAt` — is read
 * once here and passed inward; `domain/` still never reads a clock itself.
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
