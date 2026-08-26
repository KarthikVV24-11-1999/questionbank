import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { register } from '../../public/composition.js';
import { CONTENT_REGISTRY } from '../../api/http-runner.js';
import { ContentModule } from '../../api/content.module.js';
import {
  HandlerRegistry,
  MissingAuthorizationPolicyError,
  type Handler,
} from '../handler-registry.js';
import { ok } from '../../domain/result.js';
import { policy } from '../authorization.js';
import { REVIEW_POLICIES } from './policies.js';

/**
 * **F36, the review half (M4-42).**
 *
 * F36 — every handler declares an authorization policy, and the application
 * refuses to boot otherwise — has been proven for *authoring* handlers since
 * M0 (`authoring-boundary.spec.ts`). What it had never been proven for is a
 * **review** handler through content's **real composed factory**, and that is
 * the gap M4-42's register names. The distinction is not pedantic: the
 * authoring proof exercises `HandlerRegistry.of` on hand-built stubs, which
 * demonstrates the registry works but says nothing about whether the eleven
 * review handlers M4-27…M4-33 added were actually wired *through* it. A
 * review handler composed by a path that bypassed the registry would serve an
 * unguarded claim, decision or reassignment, and every existing F36 test
 * would stay green.
 *
 * So this spec runs the real `register()` from `public/composition.ts` — the
 * same function `platform/composition/` calls at boot — and asserts against
 * the registry that function actually produced.
 *
 * **The pool is a stand-in, and that is sound here rather than a shortcut.**
 * `register()` constructs repositories from the pool but issues no query at
 * construction time; what is under test is composition, not persistence. A
 * real Postgres connection would make this an integration test that proves
 * exactly the same thing more slowly.
 */

const fakePool = {} as unknown as Pool;

function realRegistry(): HandlerRegistry {
  const module = register({
    pool: fakePool,
    mediaStore: {} as never,
    idempotency: {} as never,
    clock: { now: () => new Date('2026-08-26T00:00:00.000Z') },
    identifiers: { next: () => '00000000-0000-4000-8000-000000000001' },
    audit: {} as never,
    principals: {} as never,
    reviewPolicy: { warnAfterHours: 24, escalateAfterHours: 48, leaseHours: 4, sampleRate: 0.1 },
  });

  const provider = (module.providers ?? []).find(
    (entry): entry is { provide: symbol; useValue: HandlerRegistry } =>
      typeof entry === 'object' && entry !== null && 'provide' in entry && entry.provide === CONTENT_REGISTRY,
  );
  if (provider === undefined) throw new Error('the composed content module exposes no handler registry');
  return provider.useValue;
}

/**
 * The review handlers the composed factory is expected to carry. Taken from
 * `REVIEW_POLICIES` rather than retyped, so a policy added there without a
 * handler being wired — or a handler wired without a policy — shows up as a
 * disagreement between two files instead of passing on a list this spec
 * happens to agree with itself about.
 *
 * `RecordReviewDecision` is deliberately absent from the expectation set even
 * though `RECORD_REVIEW_DECISION_POLICY` exists: the decision handler is M3's
 * `RecordItemReviewDecisionHandler`, registered under that older name, and
 * M4-26's policy documents the role grant rather than introducing a second
 * handler. Naming that exception here is the point — an unexplained gap
 * between the two lists is what this spec is for.
 */
const POLICY_WITHOUT_ITS_OWN_HANDLER = ['RecordReviewDecision'] as const;

describe('F36 — every review handler is registered with a policy, through the real composed factory', () => {
  it('composes a registry carrying every review policy that names its own handler', () => {
    const registry = realRegistry();
    const expected = REVIEW_POLICIES.map((entry) => entry.name).filter(
      (name) => !(POLICY_WITHOUT_ITS_OWN_HANDLER as readonly string[]).includes(name),
    );

    for (const name of expected) {
      expect(registry.get(name), name).toBeDefined();
    }
    // Non-vacuous: the loop above passes trivially on an empty list.
    expect(expected.length).toBe(REVIEW_POLICIES.length - POLICY_WITHOUT_ITS_OWN_HANDLER.length);
    expect(expected.length).toBeGreaterThan(8);
  });

  it('every registered review handler carries a non-empty role list', () => {
    const registry = realRegistry();
    for (const entry of REVIEW_POLICIES) {
      const handler = registry.get(entry.name);
      if (handler === undefined) continue;
      expect(handler.policy.allowedRoles.length, entry.name).toBeGreaterThan(0);
    }
  });

  /**
   * The planted violation. A policy-less review handler is added to the
   * **real** composed handler set — every handler the factory built, pulled
   * back out of the registry it built — and re-registered through
   * `ContentModule.register`, the exact call `register()` itself ends with.
   * Boot fails, which is F36 doing its job at the only moment it can.
   */
  it('is red on a policy-less review handler added to the real composed set', () => {
    const registry = realRegistry();
    const composed = registry.names.map((name) => registry.get(name)) as Handler<never, unknown>[];
    expect(composed.length).toBeGreaterThan(40);

    const policyless = {
      name: 'ClaimNextForReviewUnguarded',
      async handle() {
        return ok(undefined);
      },
    } as unknown as Handler<never, unknown>;

    expect(() =>
      ContentModule.register({ handlers: [...composed, policyless], principals: {} as never }),
    ).toThrow(MissingAuthorizationPolicyError);
  });

  it('is red on a review handler whose policy names no role at all', () => {
    const registry = realRegistry();
    const composed = registry.names.map((name) => registry.get(name)) as Handler<never, unknown>[];

    const roleless = {
      name: 'ReassignReviewUnguarded',
      policy: policy('ReassignReviewUnguarded', []),
      async handle() {
        return ok(undefined);
      },
    } as unknown as Handler<never, unknown>;

    expect(() =>
      ContentModule.register({ handlers: [...composed, roleless], principals: {} as never }),
    ).toThrow(MissingAuthorizationPolicyError);
  });

  // The green case, so the two red cases above are shown to be the policy
  // failing rather than `ContentModule.register` throwing on anything at all.
  it('accepts the real composed set unchanged', () => {
    const registry = realRegistry();
    const composed = registry.names.map((name) => registry.get(name)) as Handler<never, unknown>[];
    expect(() =>
      ContentModule.register({ handlers: composed, principals: {} as never }),
    ).not.toThrow();
  });
});
