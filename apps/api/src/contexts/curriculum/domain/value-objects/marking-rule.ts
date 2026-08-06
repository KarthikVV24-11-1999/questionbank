import { err, ok, type Result } from '../result.js';
import { createAward, type Award, type AwardError } from './award.js';
import { createCondition, type Condition, type ConditionError } from './condition.js';

export interface AppliesTo {
  readonly itemTypes: readonly string[];
  readonly sectionOrdinals?: readonly number[];
}

export interface CreateMarkingRuleProps {
  readonly id: string;
  readonly appliesTo: AppliesTo;
  readonly condition: Condition;
  readonly award: Award;
}

export type MarkingRuleErrorCode =
  | 'RULE_ID_REQUIRED'
  | 'ITEM_TYPES_REQUIRED'
  | 'ITEM_TYPE_BLANK'
  | 'SECTION_ORDINAL_INVALID'
  | ConditionError['code']
  | AwardError['code'];

export interface MarkingRuleError {
  readonly kind: 'Validation';
  readonly code: MarkingRuleErrorCode;
  readonly message: string;
}

function validationError(code: MarkingRuleErrorCode, message: string): MarkingRuleError {
  return { kind: 'Validation', code, message };
}

function validateAppliesTo(appliesTo: AppliesTo): Result<AppliesTo, MarkingRuleError> {
  if (appliesTo.itemTypes.length === 0) {
    return err(validationError('ITEM_TYPES_REQUIRED', 'appliesTo.itemTypes must list at least one item type'));
  }

  const itemTypes = appliesTo.itemTypes.map((itemType) => itemType.trim());
  if (itemTypes.some((itemType) => itemType.length === 0)) {
    return err(validationError('ITEM_TYPE_BLANK', 'appliesTo.itemTypes must not contain a blank item type'));
  }

  const ordinals = appliesTo.sectionOrdinals;
  if (ordinals !== undefined && ordinals.some((ordinal) => !Number.isInteger(ordinal) || ordinal < 1)) {
    return err(
      validationError(
        'SECTION_ORDINAL_INVALID',
        `appliesTo.sectionOrdinals must be integers >= 1, got ${ordinals.join(', ')}`,
      ),
    );
  }

  return ok({
    itemTypes: Object.freeze(itemTypes),
    ...(ordinals !== undefined ? { sectionOrdinals: Object.freeze([...ordinals]) } : {}),
  });
}

/** One ordered rule: what it applies to, when it matches, and what it awards. */
export class MarkingRule {
  private constructor(
    readonly id: string,
    readonly appliesTo: AppliesTo,
    readonly condition: Condition,
    readonly award: Award,
  ) {
    Object.freeze(this.appliesTo);
    Object.freeze(this);
  }

  static create(props: CreateMarkingRuleProps): Result<MarkingRule, MarkingRuleError> {
    const id = props.id.trim();
    if (id.length === 0) {
      return err(validationError('RULE_ID_REQUIRED', 'rule id must be non-empty'));
    }

    const appliesTo = validateAppliesTo(props.appliesTo);
    if (!appliesTo.ok) return appliesTo;

    const condition = createCondition(props.condition);
    if (!condition.ok) return err(validationError(condition.error.code, condition.error.message));

    const award = createAward(props.award);
    if (!award.ok) return err(validationError(award.error.code, award.error.message));

    return ok(new MarkingRule(id, appliesTo.value, condition.value, award.value));
  }

  appliesToItemType(itemType: string): boolean {
    return this.appliesTo.itemTypes.includes(itemType);
  }
}
