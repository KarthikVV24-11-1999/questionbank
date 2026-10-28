import { describe, expect, it } from 'vitest';
import { PROFILE, TAXONOMY } from '../testing/learning-fixtures.js';
import { conceptLabel, screenHref, type ScreenContext } from './screen-context.js';

const context = (overrides: Partial<ScreenContext> = {}): ScreenContext => ({ examProfileVersionId: PROFILE, taxonomyVersionId: TAXONOMY, lastAttemptId: 'att-9', pageKey: 'k', ...overrides });

describe('the address of a screen', () => {
  it('names the screen and carries the profile and the taxonomy on, and not the last sitting or the page\'s key', () => {
    expect(screenHref({ practice: 'run-1' }, context())).toBe(`?practice=run-1&profile=${PROFILE}&taxonomy=${TAXONOMY}`);
    expect(screenHref({ report: 'att-1' }, context())).toBe(`?report=att-1&profile=${PROFILE}&taxonomy=${TAXONOMY}`);
    expect(screenHref({}, context())).toBe(`?profile=${PROFILE}&taxonomy=${TAXONOMY}`);
  });

  it('carries on only what the page was given, and is the bare home address where it was given nothing', () => {
    expect(screenHref({}, context({ examProfileVersionId: null }))).toBe(`?taxonomy=${TAXONOMY}`);
    expect(screenHref({}, context({ taxonomyVersionId: null }))).toBe(`?profile=${PROFILE}`);
    expect(screenHref({}, context({ examProfileVersionId: null, taxonomyVersionId: null }))).toBe('?');
  });

  it('shows a concept by the start of its identifier until a route gives its name', () => {
    expect(conceptLabel('3f2a9c10-0000-4000-8000-000000000000')).toBe('Concept 3f2a9c10');
  });
});
