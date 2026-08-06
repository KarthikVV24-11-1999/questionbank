import { err, ok, type Result } from '../result.js';

/**
 * A decimal is carried as its authored literal, never as a float: the authored
 * precision is itself meaningful under SIGNIFICANT_FIGURES, and evaluation (M2)
 * must not inherit binary rounding from this layer.
 */
export type DecimalString = string;

export const COMPARISON_MODES = [
  'EXACT',
  'ABSOLUTE_TOLERANCE',
  'RELATIVE_TOLERANCE',
  'SIGNIFICANT_FIGURES',
  'RANGE',
] as const;
export type ComparisonMode = (typeof COMPARISON_MODES)[number];

export const ANSWER_FORMS = ['DECIMAL', 'FRACTION', 'SCIENTIFIC'] as const;
export type AnswerForm = (typeof ANSWER_FORMS)[number];

export interface UnitSpec {
  readonly canonical: string;
  readonly acceptedEquivalents: readonly string[];
  readonly required: boolean;
}

export interface NormalizationFlags {
  readonly trimWhitespace: boolean;
  readonly stripThousandsSeparator: boolean;
  readonly unicodeMinusToAscii: boolean;
  readonly caseInsensitiveUnit: boolean;
}

export const DEFAULT_NORMALIZATION: NormalizationFlags = Object.freeze({
  trimWhitespace: true,
  stripThousandsSeparator: true,
  unicodeMinusToAscii: true,
  caseInsensitiveUnit: true,
});

export interface CreateNumericAnswerSpecProps {
  readonly expectedValue: DecimalString;
  readonly comparisonMode: ComparisonMode;
  readonly toleranceValue?: DecimalString;
  readonly significantFigures?: number;
  readonly rangeMin?: DecimalString;
  readonly rangeMax?: DecimalString;
  readonly unit?: UnitSpec;
  readonly acceptedForms: readonly AnswerForm[];
  readonly normalization?: Partial<NormalizationFlags>;
}

export type NumericAnswerSpecErrorCode =
  | 'EXPECTED_VALUE_INVALID'
  | 'COMPARISON_MODE_UNKNOWN'
  | 'TOLERANCE_VALUE_REQUIRED'
  | 'TOLERANCE_VALUE_INVALID'
  | 'SIGNIFICANT_FIGURES_REQUIRED'
  | 'SIGNIFICANT_FIGURES_INVALID'
  | 'RANGE_BOUNDS_REQUIRED'
  | 'RANGE_BOUND_INVALID'
  | 'RANGE_BOUNDS_INVERTED'
  | 'ACCEPTED_FORMS_EMPTY'
  | 'ACCEPTED_FORMS_DUPLICATED'
  | 'ACCEPTED_FORM_UNKNOWN'
  | 'UNIT_CANONICAL_REQUIRED'
  | 'IRRELEVANT_PARAMETER';

export interface NumericAnswerSpecError {
  readonly kind: 'Validation';
  readonly code: NumericAnswerSpecErrorCode;
  readonly message: string;
}

const DECIMAL = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/u;

function validationError(code: NumericAnswerSpecErrorCode, message: string): NumericAnswerSpecError {
  return { kind: 'Validation', code, message };
}

function isDecimal(value: string | undefined): value is DecimalString {
  return typeof value === 'string' && DECIMAL.test(value.trim());
}

function requiresTolerance(mode: ComparisonMode): boolean {
  return mode === 'ABSOLUTE_TOLERANCE' || mode === 'RELATIVE_TOLERANCE';
}

function validateAcceptedForms(
  acceptedForms: readonly AnswerForm[],
): Result<readonly AnswerForm[], NumericAnswerSpecError> {
  if (acceptedForms.length === 0) {
    return err(validationError('ACCEPTED_FORMS_EMPTY', 'acceptedForms must contain at least one form'));
  }

  const unknown = acceptedForms.filter((form) => !ANSWER_FORMS.includes(form));
  if (unknown.length > 0) {
    return err(validationError('ACCEPTED_FORM_UNKNOWN', `unknown accepted form(s): ${unknown.join(', ')}`));
  }

  if (new Set(acceptedForms).size !== acceptedForms.length) {
    return err(validationError('ACCEPTED_FORMS_DUPLICATED', 'acceptedForms must not repeat a form'));
  }

  return ok(ANSWER_FORMS.filter((form) => acceptedForms.includes(form)));
}

function validateUnit(unit: UnitSpec | undefined): Result<UnitSpec | undefined, NumericAnswerSpecError> {
  if (unit === undefined) return ok(undefined);

  const canonical = unit.canonical.trim();
  if (canonical.length === 0) {
    return err(validationError('UNIT_CANONICAL_REQUIRED', 'unit.canonical must be non-empty'));
  }

  return ok({
    canonical,
    acceptedEquivalents: Object.freeze(unit.acceptedEquivalents.map((form) => form.trim())),
    required: unit.required,
  });
}

/** Every parameter that is meaningless for the chosen mode. */
function irrelevantParameters(props: CreateNumericAnswerSpecProps): string[] {
  const supplied: Array<[string, boolean]> = [
    ['toleranceValue', props.toleranceValue !== undefined && !requiresTolerance(props.comparisonMode)],
    [
      'significantFigures',
      props.significantFigures !== undefined && props.comparisonMode !== 'SIGNIFICANT_FIGURES',
    ],
    ['rangeMin', props.rangeMin !== undefined && props.comparisonMode !== 'RANGE'],
    ['rangeMax', props.rangeMax !== undefined && props.comparisonMode !== 'RANGE'],
  ];

  return supplied.filter(([, isIrrelevant]) => isIrrelevant).map(([name]) => name);
}

function validateModeParameters(
  props: CreateNumericAnswerSpecProps,
): Result<Partial<CreateNumericAnswerSpecProps>, NumericAnswerSpecError> {
  switch (props.comparisonMode) {
    case 'EXACT':
      return ok({});

    case 'ABSOLUTE_TOLERANCE':
    case 'RELATIVE_TOLERANCE': {
      if (props.toleranceValue === undefined) {
        return err(
          validationError(
            'TOLERANCE_VALUE_REQUIRED',
            `${props.comparisonMode} requires toleranceValue`,
          ),
        );
      }
      if (!isDecimal(props.toleranceValue) || Number(props.toleranceValue) <= 0) {
        return err(
          validationError(
            'TOLERANCE_VALUE_INVALID',
            `toleranceValue must be a positive decimal, got "${props.toleranceValue}"`,
          ),
        );
      }
      return ok({ toleranceValue: props.toleranceValue.trim() });
    }

    case 'SIGNIFICANT_FIGURES': {
      if (props.significantFigures === undefined) {
        return err(
          validationError('SIGNIFICANT_FIGURES_REQUIRED', 'SIGNIFICANT_FIGURES requires significantFigures'),
        );
      }
      if (!Number.isInteger(props.significantFigures) || props.significantFigures < 1) {
        return err(
          validationError(
            'SIGNIFICANT_FIGURES_INVALID',
            `significantFigures must be an integer >= 1, got ${props.significantFigures}`,
          ),
        );
      }
      return ok({ significantFigures: props.significantFigures });
    }

    case 'RANGE': {
      if (props.rangeMin === undefined || props.rangeMax === undefined) {
        return err(validationError('RANGE_BOUNDS_REQUIRED', 'RANGE requires both rangeMin and rangeMax'));
      }
      if (!isDecimal(props.rangeMin) || !isDecimal(props.rangeMax)) {
        return err(
          validationError(
            'RANGE_BOUND_INVALID',
            `range bounds must be decimals, got "${props.rangeMin}" and "${props.rangeMax}"`,
          ),
        );
      }
      if (Number(props.rangeMin) > Number(props.rangeMax)) {
        return err(
          validationError(
            'RANGE_BOUNDS_INVERTED',
            `rangeMin ${props.rangeMin} must not exceed rangeMax ${props.rangeMax}`,
          ),
        );
      }
      return ok({ rangeMin: props.rangeMin.trim(), rangeMax: props.rangeMax.trim() });
    }

    default:
      return err(
        validationError(
          'COMPARISON_MODE_UNKNOWN',
          `unknown comparisonMode "${String(props.comparisonMode)}"`,
        ),
      );
  }
}

/**
 * The ratified D-001 answer specification (DOMAIN-MODEL §12.1) as a validated,
 * immutable value object. Structure and validation only — evaluation is M2.
 */
export class NumericAnswerSpec {
  readonly expectedValue: DecimalString;
  readonly comparisonMode: ComparisonMode;
  readonly toleranceValue?: DecimalString;
  readonly significantFigures?: number;
  readonly rangeMin?: DecimalString;
  readonly rangeMax?: DecimalString;
  readonly unit?: UnitSpec;
  readonly acceptedForms: readonly AnswerForm[];
  readonly normalization: NormalizationFlags;

  private constructor(props: {
    expectedValue: DecimalString;
    comparisonMode: ComparisonMode;
    toleranceValue?: DecimalString;
    significantFigures?: number;
    rangeMin?: DecimalString;
    rangeMax?: DecimalString;
    unit?: UnitSpec;
    acceptedForms: readonly AnswerForm[];
    normalization: NormalizationFlags;
  }) {
    this.expectedValue = props.expectedValue;
    this.comparisonMode = props.comparisonMode;
    if (props.toleranceValue !== undefined) this.toleranceValue = props.toleranceValue;
    if (props.significantFigures !== undefined) this.significantFigures = props.significantFigures;
    if (props.rangeMin !== undefined) this.rangeMin = props.rangeMin;
    if (props.rangeMax !== undefined) this.rangeMax = props.rangeMax;
    if (props.unit !== undefined) this.unit = Object.freeze(props.unit);
    this.acceptedForms = Object.freeze([...props.acceptedForms]);
    this.normalization = Object.freeze({ ...props.normalization });
    Object.freeze(this);
  }

  static create(
    props: CreateNumericAnswerSpecProps,
  ): Result<NumericAnswerSpec, NumericAnswerSpecError> {
    if (!isDecimal(props.expectedValue)) {
      return err(
        validationError('EXPECTED_VALUE_INVALID', `expectedValue must be a decimal, got "${props.expectedValue}"`),
      );
    }

    const irrelevant = irrelevantParameters(props);
    if (irrelevant.length > 0) {
      return err(
        validationError(
          'IRRELEVANT_PARAMETER',
          `${irrelevant.join(', ')} ${irrelevant.length === 1 ? 'is' : 'are'} not meaningful for ${props.comparisonMode}`,
        ),
      );
    }

    const modeParameters = validateModeParameters(props);
    if (!modeParameters.ok) return modeParameters;

    const acceptedForms = validateAcceptedForms(props.acceptedForms);
    if (!acceptedForms.ok) return acceptedForms;

    const unit = validateUnit(props.unit);
    if (!unit.ok) return unit;

    return ok(
      new NumericAnswerSpec({
        expectedValue: props.expectedValue.trim(),
        comparisonMode: props.comparisonMode,
        ...modeParameters.value,
        ...(unit.value !== undefined ? { unit: unit.value } : {}),
        acceptedForms: acceptedForms.value,
        normalization: { ...DEFAULT_NORMALIZATION, ...props.normalization },
      }),
    );
  }
}
