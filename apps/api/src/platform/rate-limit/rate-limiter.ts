/**
 * The rate limiter's port, and the one way a policy is written down (M8-06, NFR SEC-09).
 *
 * **Fixed windows, two tiers.** A policy is a short window with a high allowance (the burst: a classroom logging in at nine) and a longer one with a lower rate (the sustained
 * limit: what one source or one address may do in an hour). A hit counts against every tier and is allowed only if none is over. The count of a window is one row and one
 * atomic increment, so it needs no read, no lock held by the application, and gives the same answer from every instance that shares the store.
 *
 * A token bucket would have smoothed the edges: a fixed window lets a client spend one window's allowance at its end and the next one's at its start, up to twice the
 * limit across the boundary. It would also have had to keep a fractional balance and a last-refill time, read and written together, which is a transaction or a stored
 * function per hit instead of an upsert; and its retry time is an estimate where a window's is exact. Here the boundary doubling is bounded by the other tier, since
 * twice a burst allowance across the boundary of a short window is small, and the retry time is the true end of the window that refused.
 *
 * Only the authentication routes use it so far (D98 in docs/DEBT.md).
 *
 * A refused hit still counts. A client that keeps asking while limited does not get its window back sooner, and probing at the limit costs as much as being under it.
 */
export interface RateTier {
  /** Hits allowed in one window. */
  readonly max: number;
  readonly windowMs: number;
}

/** Tiers in ascending order of window: the first is the burst, the last the sustained rate. */
export interface RatePolicy {
  readonly tiers: readonly RateTier[];
}

export type RateTierName = 'burst' | 'sustained';

export type RateDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** Whole seconds until the window that refused ends, and never less than one. */
      readonly retryAfterSeconds: number;
      /** Which tier refused. When several did, the one that ends last. */
      readonly tier: RateTierName;
    };

export interface RateLimiter {
  hit(key: string, policy: RatePolicy): Promise<RateDecision>;
}

/** The start of the window of length `windowMs` that holds `at`. Windows are aligned to the epoch, so every instance agrees on where one ends. */
export const windowStart = (at: Date, windowMs: number): number => Math.floor(at.getTime() / windowMs) * windowMs;

/** The decision for a set of counts, one per tier of the policy and in its order. Shared by the adapters so they cannot disagree about it. */
export function decide(policy: RatePolicy, counts: readonly number[], at: Date): RateDecision {
  let refused: { readonly retryAfterSeconds: number; readonly index: number } | undefined;
  policy.tiers.forEach((tier, index) => {
    if ((counts[index] ?? 0) <= tier.max) return;
    const remainingMs = windowStart(at, tier.windowMs) + tier.windowMs - at.getTime();
    // a window that holds `at` has at least a millisecond left, so this is never less than one
    const retryAfterSeconds = Math.ceil(remainingMs / 1000);
    if (refused === undefined || retryAfterSeconds >= refused.retryAfterSeconds) refused = { retryAfterSeconds, index };
  });
  if (refused === undefined) return { allowed: true };
  return { allowed: false, retryAfterSeconds: refused.retryAfterSeconds, tier: refused.index === 0 ? 'burst' : 'sustained' };
}

const UNIT_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000 };
const MAX_HITS = 1_000_000;
const MAX_TIERS = 3;
const MAX_WINDOW_MS = 24 * 3_600_000;

export type PolicyParse = { readonly ok: true; readonly value: RatePolicy } | { readonly ok: false; readonly message: string };

/** `100/10s,1000/1h`: hits per window, shortest window first. A malformed policy is refused, never repaired. */
export function parseRatePolicy(text: string): PolicyParse {
  const parts = text.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.length > MAX_TIERS) return { ok: false, message: `a policy has one to ${MAX_TIERS} tiers` };
  const tiers: RateTier[] = [];
  for (const part of parts) {
    const match = /^(\d+)\/(\d+)([smh])$/u.exec(part);
    if (match === null) return { ok: false, message: `"${part}" is not hits/window, such as 5/1m` };
    const max = Number(match[1]);
    const windowMs = Number(match[2]) * (UNIT_MS[match[3]!] ?? 0);
    if (max < 1 || max > MAX_HITS) return { ok: false, message: `"${part}": hits must be from 1 to ${MAX_HITS}` };
    if (windowMs < 1_000 || windowMs > MAX_WINDOW_MS) return { ok: false, message: `"${part}": a window is from 1 second to 24 hours` };
    const previous = tiers[tiers.length - 1];
    if (previous !== undefined && windowMs <= previous.windowMs) return { ok: false, message: `"${part}": windows must grow, shortest first` };
    tiers.push({ max, windowMs });
  }
  return { ok: true, value: { tiers } };
}

/** What one route class is limited by: where the request came from, and whom it is about (an address, or the signed-in user). */
export interface RouteLimits {
  readonly source: RatePolicy;
  readonly subject: RatePolicy | null;
}

export type RouteLimitsParse = { readonly ok: true; readonly value: RouteLimits } | { readonly ok: false; readonly message: string };

/** `source=100/10s,1000/1h;subject=5/1m,30/15m`. `source` is required; `subject` is absent where a route has nobody to name. */
export function parseRouteLimits(text: string, options: { readonly subject: boolean }): RouteLimitsParse {
  let source: RatePolicy | undefined;
  let subject: RatePolicy | null = null;
  const seen = new Set<string>();
  for (const section of text.split(';').map((part) => part.trim())) {
    const [name, policyText, ...rest] = section.split('=');
    if (name === undefined || policyText === undefined || rest.length > 0 || (name !== 'source' && name !== 'subject')) return { ok: false, message: `"${section}" is not source=... or subject=...` };
    if (seen.has(name)) return { ok: false, message: `${name} is given twice` };
    seen.add(name);
    if (name === 'subject' && !options.subject) return { ok: false, message: 'this route has no subject to limit' };
    const parsed = parseRatePolicy(policyText);
    if (!parsed.ok) return { ok: false, message: `${name}: ${parsed.message}` };
    if (name === 'source') source = parsed.value;
    else subject = parsed.value;
  }
  if (source === undefined) return { ok: false, message: 'source=... is required' };
  return { ok: true, value: { source, subject } };
}
