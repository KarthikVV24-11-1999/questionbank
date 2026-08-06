import { err, ok, type Result } from '../result.js';
import type { Award } from './award.js';
import { subsumes, type Condition } from './condition.js';
import { MarkingRule, type AppliesTo, type CreateMarkingRuleProps, type MarkingRuleError } from './marking-rule.js';

export interface MarkingRuleData {
  readonly id: string;
  readonly appliesTo: AppliesTo;
  readonly condition: Condition;
  readonly award: Award;
}

export interface MarkingRuleSetData {
  readonly schemaVersion: number;
  readonly rules: readonly MarkingRuleData[];
}

export type MarkingRuleSetErrorCode =
  | 'SCHEMA_VERSION_REQUIRED'
  | 'RULES_REQUIRED'
  | 'DUPLICATE_RULE_ID'
  | 'MISSING_TERMINAL_ALWAYS'
  | 'ALWAYS_RULE_NOT_LAST'
  | MarkingRuleError['code'];

export interface MarkingRuleSetError {
  readonly kind: 'Validation';
  readonly code: MarkingRuleSetErrorCode;
  readonly message: string;
  readonly ruleId?: string;
}

export interface MarkingRuleSetWarning {
  readonly code: 'UNREACHABLE_RULE';
  readonly message: string;
  readonly ruleId: string;
  readonly shadowedByRuleId: string;
}

function validationError(
  code: MarkingRuleSetErrorCode,
  message: string,
  ruleId?: string,
): MarkingRuleSetError {
  return { kind: 'Validation', code, message, ...(ruleId !== undefined ? { ruleId } : {}) };
}

function scopesOverlap(earlier: AppliesTo, later: AppliesTo): boolean {
  const sharesItemType = later.itemTypes.some((itemType) => earlier.itemTypes.includes(itemType));
  if (!sharesItemType) return false;

  if (earlier.sectionOrdinals === undefined || later.sectionOrdinals === undefined) return true;
  return later.sectionOrdinals.some((ordinal) => earlier.sectionOrdinals?.includes(ordinal) === true);
}

function findUnreachableRules(rules: readonly MarkingRule[]): MarkingRuleSetWarning[] {
  const warnings: MarkingRuleSetWarning[] = [];

  rules.forEach((rule, index) => {
    const shadowing = rules
      .slice(0, index)
      .find(
        (earlier) => scopesOverlap(earlier.appliesTo, rule.appliesTo) && subsumes(earlier.condition, rule.condition),
      );

    if (shadowing !== undefined) {
      warnings.push({
        code: 'UNREACHABLE_RULE',
        message: `rule ${rule.id} can never match: rule ${shadowing.id} already matches every response it would`,
        ruleId: rule.id,
        shadowedByRuleId: shadowing.id,
      });
    }
  });

  return warnings;
}

/**
 * The keystone value object (D6, ASSESSMENT-ENGINE §2): marking as ordered
 * data. Order is significant — first match wins — and the set must terminate
 * in an `ALWAYS` rule so every response has an outcome (F46).
 */
export class MarkingRuleSet {
  private constructor(
    readonly schemaVersion: number,
    readonly rules: readonly MarkingRule[],
    readonly warnings: readonly MarkingRuleSetWarning[],
  ) {
    Object.freeze(this.rules);
    Object.freeze(this.warnings);
    Object.freeze(this);
  }

  static create(data: MarkingRuleSetData): Result<MarkingRuleSet, MarkingRuleSetError> {
    if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) {
      return err(
        validationError(
          'SCHEMA_VERSION_REQUIRED',
          `schemaVersion must be an integer >= 1, got ${String(data.schemaVersion)}`,
        ),
      );
    }

    if (data.rules.length === 0) {
      return err(validationError('RULES_REQUIRED', 'a marking rule set must contain at least one rule'));
    }

    const rules: MarkingRule[] = [];
    for (const ruleData of data.rules) {
      const rule = MarkingRule.create(ruleData as CreateMarkingRuleProps);
      if (!rule.ok) return err(validationError(rule.error.code, rule.error.message, ruleData.id));
      rules.push(rule.value);
    }

    const ids = rules.map((rule) => rule.id);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate !== undefined) {
      return err(validationError('DUPLICATE_RULE_ID', `rule id ${duplicate} is used more than once`, duplicate));
    }

    const alwaysRules = rules.filter((rule) => rule.condition.kind === 'ALWAYS');
    if (alwaysRules.length === 0) {
      return err(
        validationError('MISSING_TERMINAL_ALWAYS', 'a marking rule set must terminate in an ALWAYS rule'),
      );
    }

    const misplaced = rules.slice(0, -1).find((rule) => rule.condition.kind === 'ALWAYS');
    if (misplaced !== undefined) {
      return err(
        validationError(
          'ALWAYS_RULE_NOT_LAST',
          `ALWAYS rule ${misplaced.id} must be the last rule in the set`,
          misplaced.id,
        ),
      );
    }

    return ok(new MarkingRuleSet(data.schemaVersion, rules, findUnreachableRules(rules)));
  }

  get ruleIds(): readonly string[] {
    return this.rules.map((rule) => rule.id);
  }

  rulesForItemType(itemType: string): readonly MarkingRule[] {
    return this.rules.filter((rule) => rule.appliesToItemType(itemType));
  }

  /** The plain data form, in evaluation order. Round-trips through `create`. */
  toData(): MarkingRuleSetData {
    return {
      schemaVersion: this.schemaVersion,
      rules: this.rules.map((rule) => ({
        id: rule.id,
        appliesTo: rule.appliesTo,
        condition: rule.condition,
        award: rule.award,
      })),
    };
  }
}
