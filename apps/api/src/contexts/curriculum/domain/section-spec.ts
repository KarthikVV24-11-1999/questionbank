import { err, ok, type Result } from './result.js';
import type { TimingPolicy } from './value-objects/timing-policy.js';

/** Items of each type in a section, keyed by item type. */
export type ItemTypeMix = Readonly<Record<string, number>>;

export interface SectionTiming {
  readonly durationMinutes: number;
}

export interface CreateSectionSpecProps {
  readonly ordinal: number;
  readonly name: string;
  readonly subject: string;
  readonly itemCount: number;
  readonly itemTypeMix: ItemTypeMix;
  readonly maxMarks: number;
  readonly sectionTiming?: SectionTiming;
}

export type SectionSpecErrorCode =
  | 'ORDINAL_INVALID'
  | 'NAME_REQUIRED'
  | 'SUBJECT_REQUIRED'
  | 'ITEM_COUNT_INVALID'
  | 'ITEM_TYPE_MIX_EMPTY'
  | 'ITEM_TYPE_COUNT_INVALID'
  | 'ITEM_TYPE_MIX_MISMATCH'
  | 'MAX_MARKS_INVALID'
  | 'SECTION_TIMING_INVALID';

export interface SectionSpecError {
  readonly kind: 'Validation';
  readonly code: SectionSpecErrorCode;
  readonly message: string;
  readonly ordinal?: number;
}

export type BlueprintErrorCode =
  | 'ORDINALS_NOT_CONTIGUOUS'
  | 'DUPLICATE_ORDINAL'
  | 'SECTIONS_REQUIRED'
  | 'SECTION_MARKS_MISMATCH'
  | 'SECTION_TIMING_WITHOUT_LOCKING'
  | 'SECTION_TIMING_REQUIRED_WHEN_LOCKED';

export interface BlueprintError {
  readonly kind: 'Validation' | 'RuleViolation';
  readonly code: BlueprintErrorCode;
  readonly message: string;
}

function validationError(
  code: SectionSpecErrorCode,
  message: string,
  ordinal?: number,
): SectionSpecError {
  return { kind: 'Validation', code, message, ...(ordinal !== undefined ? { ordinal } : {}) };
}

function blueprintError(
  code: BlueprintErrorCode,
  message: string,
  kind: BlueprintError['kind'] = 'Validation',
): BlueprintError {
  return { kind, code, message };
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/** One section of an exam profile and its internal arithmetic (DOMAIN-MODEL §4). */
export class SectionSpec {
  readonly ordinal: number;
  readonly name: string;
  readonly subject: string;
  readonly itemCount: number;
  readonly itemTypeMix: ItemTypeMix;
  readonly maxMarks: number;
  readonly sectionTiming?: SectionTiming;

  private constructor(props: Required<Omit<CreateSectionSpecProps, 'sectionTiming'>> & {
    sectionTiming?: SectionTiming;
  }) {
    this.ordinal = props.ordinal;
    this.name = props.name;
    this.subject = props.subject;
    this.itemCount = props.itemCount;
    this.itemTypeMix = Object.freeze({ ...props.itemTypeMix });
    this.maxMarks = props.maxMarks;
    if (props.sectionTiming !== undefined) this.sectionTiming = Object.freeze({ ...props.sectionTiming });
    Object.freeze(this);
  }

  static create(props: CreateSectionSpecProps): Result<SectionSpec, SectionSpecError> {
    if (!isPositiveInteger(props.ordinal)) {
      return err(validationError('ORDINAL_INVALID', `ordinal must be an integer >= 1, got ${props.ordinal}`));
    }

    const name = props.name.trim();
    if (name.length === 0) {
      return err(validationError('NAME_REQUIRED', 'name must be non-empty', props.ordinal));
    }

    const subject = props.subject.trim();
    if (subject.length === 0) {
      return err(validationError('SUBJECT_REQUIRED', 'subject must be non-empty', props.ordinal));
    }

    if (!isPositiveInteger(props.itemCount)) {
      return err(
        validationError(
          'ITEM_COUNT_INVALID',
          `itemCount must be an integer >= 1, got ${props.itemCount}`,
          props.ordinal,
        ),
      );
    }

    const mixEntries = Object.entries(props.itemTypeMix);
    if (mixEntries.length === 0) {
      return err(
        validationError('ITEM_TYPE_MIX_EMPTY', 'itemTypeMix must name at least one item type', props.ordinal),
      );
    }

    const invalidCount = mixEntries.find(([, count]) => !Number.isInteger(count) || count < 0);
    if (invalidCount !== undefined) {
      return err(
        validationError(
          'ITEM_TYPE_COUNT_INVALID',
          `itemTypeMix.${invalidCount[0]} must be an integer >= 0, got ${invalidCount[1]}`,
          props.ordinal,
        ),
      );
    }

    const mixTotal = mixEntries.reduce((total, [, count]) => total + count, 0);
    if (mixTotal !== props.itemCount) {
      return err(
        validationError(
          'ITEM_TYPE_MIX_MISMATCH',
          `itemTypeMix sums to ${mixTotal} but itemCount is ${props.itemCount}`,
          props.ordinal,
        ),
      );
    }

    if (!Number.isFinite(props.maxMarks) || props.maxMarks <= 0) {
      return err(
        validationError('MAX_MARKS_INVALID', `maxMarks must be greater than 0, got ${props.maxMarks}`, props.ordinal),
      );
    }

    if (
      props.sectionTiming !== undefined &&
      (!Number.isFinite(props.sectionTiming.durationMinutes) || props.sectionTiming.durationMinutes <= 0)
    ) {
      return err(
        validationError(
          'SECTION_TIMING_INVALID',
          `sectionTiming.durationMinutes must be greater than 0, got ${props.sectionTiming.durationMinutes}`,
          props.ordinal,
        ),
      );
    }

    return ok(
      new SectionSpec({
        ordinal: props.ordinal,
        name,
        subject,
        itemCount: props.itemCount,
        itemTypeMix: props.itemTypeMix,
        maxMarks: props.maxMarks,
        ...(props.sectionTiming !== undefined ? { sectionTiming: props.sectionTiming } : {}),
      }),
    );
  }

  itemCountOfType(itemType: string): number {
    return this.itemTypeMix[itemType] ?? 0;
  }
}

/**
 * The arithmetic that has to hold across a whole profile: contiguous ordinals,
 * section marks summing to the profile total, and section timing only where
 * the timing policy actually locks sections.
 */
export function checkBlueprintConsistency(
  sections: readonly SectionSpec[],
  totalMarks: number,
  timing: TimingPolicy,
): Result<true, BlueprintError> {
  if (sections.length === 0) {
    return err(blueprintError('SECTIONS_REQUIRED', 'a profile must define at least one section'));
  }

  const ordinals = sections.map((section) => section.ordinal);
  if (new Set(ordinals).size !== ordinals.length) {
    return err(blueprintError('DUPLICATE_ORDINAL', `section ordinals repeat: ${ordinals.join(', ')}`));
  }

  const expected = Array.from({ length: sections.length }, (_unused, index) => index + 1);
  if ([...ordinals].sort((a, b) => a - b).join(',') !== expected.join(',')) {
    return err(
      blueprintError(
        'ORDINALS_NOT_CONTIGUOUS',
        `section ordinals must run 1..${sections.length} without gaps, got ${ordinals.join(', ')}`,
      ),
    );
  }

  const marksTotal = sections.reduce((total, section) => total + section.maxMarks, 0);
  if (marksTotal !== totalMarks) {
    return err(
      blueprintError(
        'SECTION_MARKS_MISMATCH',
        `section maxMarks sum to ${marksTotal} but the profile total is ${totalMarks}`,
        'RuleViolation',
      ),
    );
  }

  const timed = sections.filter((section) => section.sectionTiming !== undefined);
  if (!timing.sectionLocking && timed.length > 0) {
    return err(
      blueprintError(
        'SECTION_TIMING_WITHOUT_LOCKING',
        `section(s) ${timed.map((section) => section.ordinal).join(', ')} declare sectionTiming, but the profile does not lock sections`,
        'RuleViolation',
      ),
    );
  }

  if (timing.sectionLocking && timed.length !== sections.length) {
    return err(
      blueprintError(
        'SECTION_TIMING_REQUIRED_WHEN_LOCKED',
        'every section must declare sectionTiming when the profile locks sections',
        'RuleViolation',
      ),
    );
  }

  return ok(true);
}
