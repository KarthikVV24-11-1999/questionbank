import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCatalog, parseCatalog } from './event-catalog.js';
import { NAMING_EXCEPTIONS, PAST_TENSE_VERBS, checkNaming } from './event-naming.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const TAXONOMY = readFileSync(resolve(ROOT, 'docs/EVENT-TAXONOMY.md'), 'utf8');
const DEBT = readFileSync(resolve(ROOT, 'docs/DEBT.md'), 'utf8');
const NAMES = readCatalog(resolve(ROOT, 'docs/EVENT-TAXONOMY.md')).map((event) => event.name);

describe('the naming convention (EVENT-TAXONOMY §2)', () => {
  it('holds for every name in the catalog, but the two registered exceptions', () => {
    expect(checkNaming(NAMES, DEBT)).toEqual([]);
    expect(Object.keys(NAMING_EXCEPTIONS).sort()).toEqual(['ai.tutor_turn', 'client.error']);
    expect(NAMES.length).toBeGreaterThan(70);
  });

  describe('is red on a planted violation', () => {
    it('a new name whose verb is not accepted: foo.bar_happening', () => {
      expect(checkNaming([...NAMES, 'foo.bar_happening'], DEBT)).toEqual([{ rule: 'NOT_A_PAST_TENSE_FACT', name: 'foo.bar_happening', detail: expect.stringContaining('"happening"') }]);
    });

    it('a new name added to the document, read through the same parse the gate uses', () => {
      const planted = TAXONOMY.replace('## 3. Catalog', '## 3. Catalog\n| Event | Key payload | Owner |\n|---|---|---|\n| `foo.bar_happening` | `x` | M7 |');
      expect(checkNaming(parseCatalog(planted).map((event) => event.name), DEBT).map((violation) => violation.name)).toEqual(['foo.bar_happening']);
    });

    it('a name that is not shaped like one, whatever its verb', () => {
      expect(checkNaming([...NAMES, 'Foo.bar_started', 'foo-bar_started', 'foo_started'], DEBT).map((violation) => [violation.rule, violation.name])).toEqual([
        ['NAME_SHAPE', 'Foo.bar_started'],
        ['NAME_SHAPE', 'foo-bar_started'],
        ['NAME_SHAPE', 'foo_started'],
      ]);
    });

    it('a name that merely contains an accepted verb is not accepted for it', () => {
      expect(checkNaming(['foo.started_thing', 'foo.bar_restarted'], DEBT, PAST_TENSE_VERBS, {}).map((violation) => violation.rule)).toEqual(['NOT_A_PAST_TENSE_FACT', 'NOT_A_PAST_TENSE_FACT']);
    });

    it('an exception for an event that is not in the catalog, one the name does not need, and one with no register entry', () => {
      const exceptions = { 'gone.event_thing': { debt: 'D89', because: 'x' }, 'foo.bar_started': { debt: 'D89', because: 'x' }, 'ai.tutor_turn': { debt: 'D9999', because: 'x' } };
      const found = checkNaming([...NAMES.filter((name) => name !== 'client.error' && name !== 'ai.tutor_turn'), 'foo.bar_started', 'ai.tutor_turn'], DEBT, PAST_TENSE_VERBS, exceptions).map((violation) => [violation.rule, violation.name]);
      expect(found).toEqual([['EXCEPTION_NOT_IN_CATALOG', 'gone.event_thing'], ['EXCEPTION_NOT_NEEDED', 'foo.bar_started'], ['EXCEPTION_NOT_REGISTERED', 'ai.tutor_turn']]);
    });
  });

  it('accepts a verb phrase only as a whole: submitted_for_review is a fact, and a bare "review" is not', () => {
    expect(PAST_TENSE_VERBS.has('submitted_for_review')).toBe(true);
    expect(checkNaming(['item.submitted_for_review'], DEBT, PAST_TENSE_VERBS, {})).toEqual([]);
    expect(checkNaming(['item.ready_for_review'], DEBT, PAST_TENSE_VERBS, {}).map((violation) => violation.rule)).toEqual(['NOT_A_PAST_TENSE_FACT']);
  });
});
