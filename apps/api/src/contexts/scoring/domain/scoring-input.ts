import { err, ok, type Result } from './result.js';
import { validationError, type ScoringError } from './scoring-error.js';
import { checkKeyMatchesItemType, type AnswerKey } from './answer-key.js';
import { rationalFromNumber, type Rational } from './numeric/decimal.js';

/**
 * The `Attempt` half of the scoring function (ASSESSMENT-ENGINE §3).
 *
 * `Attempt` and `Form` are M6 aggregates and do not exist yet, so Scoring owns
 * its own input contract rather than waiting on them — this is the ROADMAP's
 * "synthetic attempt". When Assessment lands it maps its aggregates onto this
 * shape across an anti-corruption boundary; the executor never learns that
 * `Attempt` exists.
 *
 * **Responses arrive projected, never as an event log.** Response projection
 * (§4) is M6's work and M6's determinism gate. What reaches Scoring is the
 * derived current answer per slot, and an absent answer means unattempted —
 * there is no other way to express it, so the two can never disagree.
 */

/** The reproducibility guarantee, mirroring `AttemptPin` (DOMAIN-MODEL §6). */
export interface ScoringPin {
  readonly examProfileVersionId: string;
  readonly markingRuleSetHash: string;
  readonly ruleSchemaVersion: number;
  readonly taxonomyVersionId: string;
  readonly itemVersionIds: readonly string[];
}

export interface MatchedPair {
  readonly left: string;
  readonly right: string;
}

/**
 * What the learner's answer was, already projected. `NUMERIC_ENTRY.raw` is the
 * learner's literal keystrokes — normalization happens at M2-04, inside the
 * evaluator, because D-001 rule 1 requires normalizing before comparison and
 * nowhere else.
 */
export type ResponseSnapshot =
  | { readonly kind: 'OPTION_SELECTION'; readonly optionIds: readonly string[] }
  | { readonly kind: 'MATCHING'; readonly pairs: readonly MatchedPair[] }
  | { readonly kind: 'NUMERIC_ENTRY'; readonly raw: string };

/**
 * Item-level overrides (§2.5), supplied by the caller because they are a
 * form-level fact and `Form` is M6 (DEC-3).
 */
export type SlotOverride =
  | { readonly kind: 'DROPPED'; readonly slotId: string; readonly reason: string }
  | { readonly kind: 'BONUS'; readonly slotId: string; readonly reason: string }
  | {
      readonly kind: 'KEY_CORRECTED';
      readonly slotId: string;
      readonly reason: string;
      readonly replacementKey: AnswerKey;
    };

/** What a caller supplies. The exact mark form is derived, never supplied. */
export interface CreateScoredSlot {
  readonly slotId: string;
  readonly ordinal: number;
  readonly itemType: string;
  readonly itemVersionId: string;
  readonly marksAvailable: number;
  readonly answerKey: AnswerKey;
  /** Absent means unattempted. There is no `attempted: false` to fall out of step with. */
  readonly response?: ResponseSnapshot;
}

export interface ScoredSlot extends CreateScoredSlot {
  /**
   * The same value as an exact rational, converted once at construction rather
   * than at every use. A caller cannot supply it, so it can never disagree
   * with `marksAvailable`.
   */
  readonly marksAvailableExact: Rational;
}

export interface CreateScoredSection {
  readonly ordinal: number;
  readonly slots: readonly CreateScoredSlot[];
}

export interface CreateScoringInputProps {
  readonly attemptId: string;
  readonly pin: ScoringPin;
  readonly sections: readonly CreateScoredSection[];
  readonly overrides: readonly SlotOverride[];
}

export interface ScoredSection {
  readonly ordinal: number;
  readonly slots: readonly ScoredSlot[];
}

export interface ScoringInput {
  readonly attemptId: string;
  readonly pin: ScoringPin;
  readonly sections: readonly ScoredSection[];
  readonly overrides: readonly SlotOverride[];
}

export type ScoringInputErrorCode =
  | 'ATTEMPT_ID_REQUIRED'
  | 'PIN_FIELD_REQUIRED'
  | 'RULE_SCHEMA_VERSION_INVALID'
  | 'ITEM_VERSION_IDS_REQUIRED'
  | 'ITEM_VERSION_ID_BLANK'
  | 'SECTIONS_REQUIRED'
  | 'SECTION_ORDINALS_NOT_CONTIGUOUS'
  | 'SLOTS_REQUIRED'
  | 'SLOT_ORDINALS_NOT_CONTIGUOUS'
  | 'SLOT_ID_REQUIRED'
  | 'SLOT_ID_DUPLICATE'
  | 'ITEM_TYPE_REQUIRED'
  | 'SLOT_ITEM_VERSION_ID_REQUIRED'
  | 'MARKS_AVAILABLE_INVALID'
  | 'RESPONSE_EMPTY'
  | 'ANSWER_KEY_MISMATCH'
  | 'OVERRIDE_SLOT_UNKNOWN'
  | 'OVERRIDE_DUPLICATE'
  | 'OVERRIDE_KEY_MISMATCH';

export type ScoringInputError = ScoringError<ScoringInputErrorCode>;

function invalid(code: ScoringInputErrorCode, message: string): ScoringInputError {
  return validationError(code, message);
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Ordinals must run 1, 2, 3 … with no gap, no duplicate and no reordering.
 * Callers reject the empty collection first, so the list is never empty here.
 */
function checkContiguousFromOne(
  ordinals: readonly number[],
  code: ScoringInputErrorCode,
  subject: string,
): Result<true, ScoringInputError> {
  const expected = ordinals.map((_, index) => index + 1);
  if (ordinals.join(',') !== expected.join(',')) {
    return err(invalid(code, `${subject} ordinals must be contiguous from 1, got ${ordinals.join(', ')}`));
  }
  return ok(true);
}

function validatePin(pin: ScoringPin): Result<ScoringPin, ScoringInputError> {
  const required: readonly (readonly [keyof ScoringPin, string])[] = [
    ['examProfileVersionId', pin.examProfileVersionId],
    ['markingRuleSetHash', pin.markingRuleSetHash],
    ['taxonomyVersionId', pin.taxonomyVersionId],
  ];

  for (const [field, value] of required) {
    if (isBlank(value)) {
      return err(invalid('PIN_FIELD_REQUIRED', `pin.${String(field)} is required`));
    }
  }

  if (!Number.isInteger(pin.ruleSchemaVersion) || pin.ruleSchemaVersion < 1) {
    return err(
      invalid(
        'RULE_SCHEMA_VERSION_INVALID',
        `pin.ruleSchemaVersion must be an integer >= 1, got ${pin.ruleSchemaVersion}`,
      ),
    );
  }

  if (pin.itemVersionIds.length === 0) {
    return err(invalid('ITEM_VERSION_IDS_REQUIRED', 'pin.itemVersionIds must list at least one item version'));
  }

  if (pin.itemVersionIds.some(isBlank)) {
    return err(invalid('ITEM_VERSION_ID_BLANK', 'pin.itemVersionIds must not contain a blank identifier'));
  }

  return ok(
    Object.freeze({
      examProfileVersionId: pin.examProfileVersionId,
      markingRuleSetHash: pin.markingRuleSetHash,
      ruleSchemaVersion: pin.ruleSchemaVersion,
      taxonomyVersionId: pin.taxonomyVersionId,
      itemVersionIds: Object.freeze([...pin.itemVersionIds]),
    }),
  );
}

/**
 * An empty response is not an unattempted one. A learner who selects an option
 * and then clears it has an absent response; a payload carrying an empty
 * selection is a projection defect, and swallowing it would silently score the
 * slot as unattempted.
 */
function validateResponse(
  response: ResponseSnapshot,
  slotId: string,
): Result<ResponseSnapshot, ScoringInputError> {
  switch (response.kind) {
    case 'OPTION_SELECTION':
      return response.optionIds.length === 0
        ? err(invalid('RESPONSE_EMPTY', `slot ${slotId} carries an empty option selection; omit it instead`))
        : ok(Object.freeze({ kind: 'OPTION_SELECTION' as const, optionIds: Object.freeze([...response.optionIds]) }));

    case 'MATCHING':
      return response.pairs.length === 0
        ? err(invalid('RESPONSE_EMPTY', `slot ${slotId} carries an empty matching set; omit it instead`))
        : ok(Object.freeze({ kind: 'MATCHING' as const, pairs: Object.freeze([...response.pairs]) }));

    case 'NUMERIC_ENTRY':
      return isBlank(response.raw)
        ? err(invalid('RESPONSE_EMPTY', `slot ${slotId} carries a blank numeric entry; omit it instead`))
        : ok(Object.freeze({ kind: 'NUMERIC_ENTRY' as const, raw: response.raw }));
  }
}

function validateSlot(slot: CreateScoredSlot): Result<ScoredSlot, ScoringInputError> {
  if (isBlank(slot.slotId)) {
    return err(invalid('SLOT_ID_REQUIRED', 'every slot requires a slotId'));
  }
  if (isBlank(slot.itemType)) {
    return err(invalid('ITEM_TYPE_REQUIRED', `slot ${slot.slotId} requires an itemType`));
  }
  if (isBlank(slot.itemVersionId)) {
    return err(invalid('SLOT_ITEM_VERSION_ID_REQUIRED', `slot ${slot.slotId} requires an itemVersionId`));
  }

  // A key of the wrong variant would be scored against the wrong comparison
  // entirely, so the pairing is refused at the boundary.
  const keyFits = checkKeyMatchesItemType(slot.answerKey, slot.itemType);
  if (!keyFits.ok) {
    return err(invalid('ANSWER_KEY_MISMATCH', `slot ${slot.slotId}: ${keyFits.error.message}`));
  }

  // Converting is also the finiteness check, so there is one gate rather than
  // two that could disagree.
  const exact = rationalFromNumber(slot.marksAvailable);
  if (!exact.ok || slot.marksAvailable <= 0) {
    return err(
      invalid(
        'MARKS_AVAILABLE_INVALID',
        `slot ${slot.slotId} marksAvailable must be finite and greater than 0, got ${slot.marksAvailable}`,
      ),
    );
  }

  const base = {
    slotId: slot.slotId,
    ordinal: slot.ordinal,
    itemType: slot.itemType,
    itemVersionId: slot.itemVersionId,
    marksAvailable: slot.marksAvailable,
    marksAvailableExact: exact.value,
    answerKey: slot.answerKey,
  };

  if (slot.response === undefined) {
    return ok(Object.freeze(base));
  }

  const response = validateResponse(slot.response, slot.slotId);
  if (!response.ok) return err(response.error);

  return ok(Object.freeze({ ...base, response: response.value }));
}

function validateSections(
  sections: readonly CreateScoredSection[],
): Result<readonly ScoredSection[], ScoringInputError> {
  if (sections.length === 0) {
    return err(invalid('SECTIONS_REQUIRED', 'a scoring input requires at least one section'));
  }

  const sectionOrdinals = checkContiguousFromOne(
    sections.map((section) => section.ordinal),
    'SECTION_ORDINALS_NOT_CONTIGUOUS',
    'section',
  );
  if (!sectionOrdinals.ok) return err(sectionOrdinals.error);

  const seenSlotIds = new Set<string>();
  const validated: ScoredSection[] = [];

  for (const section of sections) {
    if (section.slots.length === 0) {
      return err(invalid('SLOTS_REQUIRED', `section ${section.ordinal} requires at least one slot`));
    }

    const slotOrdinals = checkContiguousFromOne(
      section.slots.map((slot) => slot.ordinal),
      'SLOT_ORDINALS_NOT_CONTIGUOUS',
      `section ${section.ordinal} slot`,
    );
    if (!slotOrdinals.ok) return err(slotOrdinals.error);

    const slots: ScoredSlot[] = [];
    for (const slot of section.slots) {
      const validatedSlot = validateSlot(slot);
      if (!validatedSlot.ok) return err(validatedSlot.error);

      if (seenSlotIds.has(validatedSlot.value.slotId)) {
        return err(
          invalid('SLOT_ID_DUPLICATE', `slotId ${validatedSlot.value.slotId} appears more than once`),
        );
      }
      seenSlotIds.add(validatedSlot.value.slotId);
      slots.push(validatedSlot.value);
    }

    validated.push(Object.freeze({ ordinal: section.ordinal, slots: Object.freeze(slots) }));
  }

  return ok(Object.freeze(validated));
}

/**
 * An override naming a slot that is not in the input is rejected here rather
 * than ignored downstream (DEC-3). A silent no-op is a dropped or bonus item
 * quietly not applied to a real candidate's score, and it would be invisible in
 * the resulting record.
 */
function validateOverrides(
  overrides: readonly SlotOverride[],
  slotsById: ReadonlyMap<string, ScoredSlot>,
): Result<readonly SlotOverride[], ScoringInputError> {
  const seen = new Set<string>();

  for (const override of overrides) {
    const slot = slotsById.get(override.slotId);
    if (slot === undefined) {
      return err(
        invalid('OVERRIDE_SLOT_UNKNOWN', `override names slot ${override.slotId}, which is not in this attempt`),
      );
    }
    if (seen.has(override.slotId)) {
      return err(invalid('OVERRIDE_DUPLICATE', `slot ${override.slotId} carries more than one override`));
    }
    if (override.kind === 'KEY_CORRECTED') {
      const keyFits = checkKeyMatchesItemType(override.replacementKey, slot.itemType);
      if (!keyFits.ok) {
        return err(
          invalid('OVERRIDE_KEY_MISMATCH', `corrected key for slot ${override.slotId}: ${keyFits.error.message}`),
        );
      }
    }
    seen.add(override.slotId);
  }

  return ok(Object.freeze(overrides.map((override) => Object.freeze({ ...override }))));
}

export function createScoringInput(props: CreateScoringInputProps): Result<ScoringInput, ScoringInputError> {
  if (isBlank(props.attemptId)) {
    return err(invalid('ATTEMPT_ID_REQUIRED', 'attemptId is required'));
  }

  const pin = validatePin(props.pin);
  if (!pin.ok) return err(pin.error);

  const sections = validateSections(props.sections);
  if (!sections.ok) return err(sections.error);

  const slotsById = new Map(
    sections.value.flatMap((section) => section.slots.map((slot) => [slot.slotId, slot] as const)),
  );
  const overrides = validateOverrides(props.overrides, slotsById);
  if (!overrides.ok) return err(overrides.error);

  return ok(
    Object.freeze({
      attemptId: props.attemptId,
      pin: pin.value,
      sections: sections.value,
      overrides: overrides.value,
    }),
  );
}

/** The single definition of "unattempted" — an absent projected response. */
export function isUnattempted(slot: ScoredSlot): boolean {
  return slot.response === undefined;
}

/** Every slot in the input, in section then slot order. */
export function allSlots(input: ScoringInput): readonly ScoredSlot[] {
  return input.sections.flatMap((section) => section.slots);
}
