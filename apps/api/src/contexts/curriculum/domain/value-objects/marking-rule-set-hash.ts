import { createHash } from 'node:crypto';
import type { Award } from './award.js';
import type { Condition } from './condition.js';
import type { MarkingRuleSet } from './marking-rule-set.js';

/**
 * The canonical serialization pinned into every future `ScoreRecord` (R2).
 *
 * Rules are emitted in evaluation order — order is semantic — while every
 * object's keys are emitted in a fixed order and numbers in a fixed format, so
 * the same rule set always produces the same bytes regardless of how it was
 * built or in what order its keys were written.
 */
export function canonicalizeMarkingRuleSet(ruleSet: MarkingRuleSet): string {
  return serialize({
    schemaVersion: formatNumber(ruleSet.schemaVersion),
    rules: ruleSet.rules.map((rule) => ({
      id: rule.id,
      appliesTo: {
        itemTypes: [...rule.appliesTo.itemTypes].sort(),
        sectionOrdinals:
          rule.appliesTo.sectionOrdinals === undefined
            ? null
            : [...rule.appliesTo.sectionOrdinals].sort((a, b) => a - b).map(formatNumber),
      },
      condition: canonicalCondition(rule.condition),
      award: canonicalAward(rule.award),
    })),
  });
}

/** A stable, process- and library-independent hash of the canonical form. */
export function hashMarkingRuleSet(ruleSet: MarkingRuleSet): string {
  return createHash('sha256').update(canonicalizeMarkingRuleSet(ruleSet), 'utf8').digest('hex');
}

type Canonical = string | null | readonly Canonical[] | { readonly [key: string]: Canonical };

/**
 * Numbers are formatted explicitly so that 4, 4.0 and 4e0 — indistinguishable
 * in JavaScript — cannot produce different bytes.
 */
function formatNumber(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

function canonicalCondition(condition: Condition): Canonical {
  switch (condition.kind) {
    case 'PARTIAL_CORRECT_SELECTED':
      return {
        kind: condition.kind,
        minCorrect: formatNumber(condition.minCorrect),
        noIncorrect: condition.noIncorrect ? 'true' : 'false',
      };
    case 'MATCHING_PAIRS_CORRECT':
      return { kind: condition.kind, count: formatNumber(condition.count) };
    default:
      return { kind: condition.kind };
  }
}

function canonicalAward(award: Award): Canonical {
  return award.kind === 'FULL_MARKS'
    ? { kind: award.kind }
    : { kind: award.kind, marks: formatNumber(award.marks) };
}

/** Deterministic JSON: keys sorted, no whitespace, strings escaped by JSON.stringify. */
function serialize(value: Canonical): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;

  const entries = Object.entries(value as { readonly [key: string]: Canonical }).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${serialize(nested)}`).join(',')}}`;
}
