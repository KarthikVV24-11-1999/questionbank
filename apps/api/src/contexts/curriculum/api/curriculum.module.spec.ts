import { describe, expect, it } from 'vitest';
import { CurriculumModule } from './curriculum.module.js';
import type { Handler } from '../application/handler-registry.js';
import { taxonomyHandlers } from '../application/handlers/taxonomy-handlers.js';
import { examProfileHandlers } from '../application/handlers/exam-profile-handlers.js';
import { migrationHandlers } from '../application/handlers/migration-handlers.js';
import { curriculumQueries } from '../application/queries/curriculum-queries.js';

const NO_DEPENDENCIES = {} as never;
const principals = { resolve: (): null => null };

function everyHandler(): readonly Handler<never, unknown>[] {
  return [
    ...taxonomyHandlers(NO_DEPENDENCIES),
    ...examProfileHandlers(NO_DEPENDENCIES),
    ...migrationHandlers(NO_DEPENDENCIES),
    ...curriculumQueries(NO_DEPENDENCIES),
  ];
}

/**
 * F36 — "a handler without a declared policy fails to register at boot"
 * (BACKEND-ARCHITECTURE §5). The registry is what enforces it, and this is the
 * path the application actually boots through.
 */
describe('F36 — the module refuses to boot without an authorization policy', () => {
  it('registers when every handler declares one', () => {
    expect(() => CurriculumModule.register({ handlers: everyHandler(), principals })).not.toThrow();
  });

  it('throws when a handler declares no policy at all', () => {
    const unguarded = {
      name: 'SmuggledCommand',
      handle: async () => ({ ok: true, value: null }),
    } as unknown as Handler<never, unknown>;

    expect(() =>
      CurriculumModule.register({ handlers: [...everyHandler(), unguarded], principals }),
    ).toThrow(/SmuggledCommand declares no authorization policy/u);
  });

  it('throws when a handler declares a policy that permits nobody', () => {
    const empty = {
      name: 'EmptyPolicyCommand',
      policy: { name: 'EmptyPolicyCommand', allowedRoles: [], requiresStepUp: false },
      handle: async () => ({ ok: true, value: null }),
    } as unknown as Handler<never, unknown>;

    expect(() => CurriculumModule.register({ handlers: [...everyHandler(), empty], principals })).toThrow(
      /declares no authorization policy/u,
    );
  });

  it('builds no controller when registration fails', () => {
    const unguarded = { name: 'SmuggledCommand', handle: async () => ({ ok: true, value: null }) } as unknown as Handler<
      never,
      unknown
    >;
    let built: unknown;

    try {
      built = CurriculumModule.register({ handlers: [unguarded], principals });
    } catch {
      built = undefined;
    }

    expect(built).toBeUndefined();
  });

  it('covers all 22 commands and queries', () => {
    expect(everyHandler()).toHaveLength(22);
    for (const handler of everyHandler()) {
      expect(handler.policy.allowedRoles.length, handler.name).toBeGreaterThan(0);
    }
  });
});
