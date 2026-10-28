import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LEARNING_HANDLERS_DIRECTORY, policiesUnder } from '../fitness/policy-declarations.js';
import { ROLES } from '../platform/auth/roles.js';

/** Every Learning handler is routed or says why not, and INV-01 holds for the set (M7-51, DEC-M7-26). */
const SRC = fileURLToPath(new URL('..', import.meta.url));
const SPEC_PATH = fileURLToPath(new URL('../../../../packages/contracts/openapi/learning.yaml', import.meta.url));

interface OpenApi {
  readonly paths: Record<string, Record<string, { readonly 'x-handler'?: string }>>;
}

const scan = policiesUnder(LEARNING_HANDLERS_DIRECTORY(SRC));
const POLICY_BY_NAME = new Map(scan.declared.map((entry) => [entry.name, entry]));
const SPEC = parse(readFileSync(SPEC_PATH, 'utf8')) as OpenApi;
const CONTROLLER = readFileSync(fileURLToPath(new URL('../contexts/learning/api/learning.controller.ts', import.meta.url)), 'utf8');
const routed = Object.values(SPEC.paths).flatMap((item) => Object.values(item).map((operation) => operation['x-handler'] as string));

/** What the learner reads and writes about themself: each is scoped to the caller's own learner. */
const LEARNER_HANDLERS = ['CreateBookmark', 'GetDiagnosticReport', 'GetPaceAnalytics', 'GetReviewPlan', 'ListBookmarks', 'ListErrorEntries', 'SetErrorCause', 'SuggestRemediationConcepts'];
/** What the system does on a learner's behalf, from the outbox or a seam, never from a request. */
const SYSTEM_HANDLERS = ['GenerateDiagnosticReport', 'RecordMasteryEvidence'];
const OPERATOR_HANDLERS = ['PublishMasteryRuleSet'];

/**
 * A handler with a policy and no route is a decision, not an oversight: each is named here with the reason it has none, and an entry
 * leaves the list in the commit that routes it. The F15 rule is one-directional — an endpoint without a spec fails, a handler without
 * an endpoint is invisible to it — so this is the other direction.
 */
const UNROUTED: Record<string, string> = {
  GenerateDiagnosticReport: 'run by the relay when a score lands, as the system; a learner never asks for a report to be built',
  RecordMasteryEvidence: 'run by the relay when a score lands, as the system; evidence is never posted by a client',
  PublishMasteryRuleSet: 'an admin action under step-up with no console to call it from; the rule set is published by operations',
};

describe('every Learning handler is routed or says why not', () => {
  it('has exactly these eleven handlers, every policy readable', () => {
    expect(scan.unreadableDeclarations).toBe(0);
    expect([...POLICY_BY_NAME.keys()].sort()).toEqual([...LEARNER_HANDLERS, ...SYSTEM_HANDLERS, ...OPERATOR_HANDLERS].sort());
    expect(scan.declared).toHaveLength(POLICY_BY_NAME.size);
  });

  it('routes a handler or lists it as unrouted with a reason, never both and never neither', () => {
    const names = [...POLICY_BY_NAME.keys()].sort();
    expect([...routed, ...Object.keys(UNROUTED)].sort()).toEqual(names);
    expect(routed.filter((name) => name in UNROUTED)).toEqual([]);
    for (const [name, reason] of Object.entries(UNROUTED)) expect(reason.length, name).toBeGreaterThan(20);
  });

  it('routes only handlers that exist', () => {
    for (const name of routed) expect([...POLICY_BY_NAME.keys()], name).toContain(name);
  });
});

describe('the document and the controller agree', () => {
  it('routes exactly the handlers the document names, from the controller', () => {
    const fromController = [...CONTROLLER.matchAll(/this\.run\(response, headers, '(\w+)'/gu)].map((match) => match[1]);
    expect(fromController.sort()).toEqual([...routed].sort());
  });

  it('serves exactly the document\u2019s paths and methods', () => {
    const served = [...CONTROLLER.matchAll(/@(Get|Post|Put)\('([^']+)'\)/gu)].map((match) => `${(match[1] as string).toLowerCase()} ${(match[2] as string).replaceAll(/:(\w+)/gu, '{$1}')}`);
    const documented = Object.entries(SPEC.paths).flatMap(([path, item]) => Object.keys(item).map((method) => `${method} ${path}`));
    expect(served.sort()).toEqual(documented.sort());
  });

  it('mounts every path under /v1/learning/', () => {
    for (const path of Object.keys(SPEC.paths)) expect(path.startsWith('/v1/learning/'), path).toBe(true);
  });
});

describe('INV-01 — who may reach what, for Learning', () => {
  const rolesOf = (name: string): readonly string[] => POLICY_BY_NAME.get(name)!.roles.map((key) => ROLES[key as keyof typeof ROLES]);

  it('admits no learner and no guest to a system or operator handler', () => {
    for (const name of [...SYSTEM_HANDLERS, ...OPERATOR_HANDLERS]) {
      expect(rolesOf(name), name).not.toContain(ROLES.learner);
      expect(rolesOf(name), name).not.toContain(ROLES.guest);
    }
  });

  it('admits a learner, and only a learner, to exactly the eight learner handlers', () => {
    for (const name of LEARNER_HANDLERS) expect(rolesOf(name), name).toEqual([ROLES.learner]);
    expect([...POLICY_BY_NAME.keys()].filter((name) => rolesOf(name).includes(ROLES.learner)).sort()).toEqual(LEARNER_HANDLERS);
  });

  it('keeps what counts as knowing something an admin\'s, under step-up, and the system\'s a system\'s', () => {
    expect(rolesOf('PublishMasteryRuleSet')).toEqual([ROLES.admin]);
    expect(POLICY_BY_NAME.get('PublishMasteryRuleSet')!.requiresStepUp).toBe(true);
    for (const name of SYSTEM_HANDLERS) expect(rolesOf(name), name).toEqual([ROLES.system]);
  });
});
