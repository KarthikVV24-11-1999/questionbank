import { err, ok, type Result } from '../result.js';
import { validationError, type ScoringError } from '../scoring-error.js';
import type { NormalizationFlags } from '../answer-key.js';

/**
 * D-001 rule 1: normalization is applied to learner input **before**
 * comparison, never after. This module is the only place it happens.
 *
 * Every flag is honoured independently, and every flag turned off is a no-op —
 * a normalization that cannot be switched off is a comparison rule wearing a
 * different name, and would silently change what a published spec means.
 */

export interface NormalizedEntry {
  /** The numeric text, separators removed and sign folded to ASCII. */
  readonly value: string;
  /** The unit as the learner wrote it, case-folded when the flag allows. Empty when none was supplied. */
  readonly unit: string;
}

export type NormalizeErrorCode = 'ENTRY_EMPTY' | 'NO_NUMERIC_VALUE';

export type NormalizeError = ScoringError<NormalizeErrorCode>;

/** Unicode dashes a learner's keyboard or a paste can produce where ASCII `-` was meant. */
const MINUS_LIKE = /[\u2212\u2012\u2013\u2014\u2015\uFE63\uFF0D]/gu;

/** Spaces that are not U+0020 — non-breaking, thin, narrow no-break, and friends. */
const EXOTIC_SPACE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

/**
 * Finds where the number ends and the unit begins.
 *
 * A scanner rather than one regex: the number may carry a sign, grouped
 * digits, a decimal point, a fraction bar, and an exponent in either `e` or
 * `×10^` form, and a single expression covering all of that is unreadable and
 * unreviewable — an unacceptable property for code that decides a mark.
 */
function splitValueAndUnit(text: string): { readonly value: string; readonly unit: string } {
  let index = 0;

  const consumeSign = (): void => {
    if (text[index] === '+' || text[index] === '-') index += 1;
  };

  const consumeDigitsWithSeparators = (): boolean => {
    let sawDigit = false;
    let sawPoint = false;
    while (index < text.length) {
      const character = text[index];
      if (isDigit(character)) {
        sawDigit = true;
        index += 1;
        continue;
      }
      // A separator counts only between digits, so a trailing comma stays with the unit.
      if ((character === ',' || character === ' ') && sawDigit && isDigit(text[index + 1])) {
        index += 1;
        continue;
      }
      if (character === '.' && !sawPoint && (sawDigit || isDigit(text[index + 1]))) {
        sawPoint = true;
        index += 1;
        continue;
      }
      break;
    }
    return sawDigit;
  };

  consumeSign();
  if (!consumeDigitsWithSeparators()) return { value: '', unit: text.trim() };

  // A fraction bar, if the next non-space run is `/ digits`.
  const afterMantissa = index;
  let probe = index;
  while (text[probe] === ' ') probe += 1;
  if (text[probe] === '/') {
    probe += 1;
    while (text[probe] === ' ') probe += 1;
    index = probe;
    consumeSign();
    if (!consumeDigitsWithSeparators()) index = afterMantissa;
  }

  // An exponent, in `e±n` or `×10^±n` form.
  const beforeExponent = index;
  probe = index;
  while (text[probe] === ' ') probe += 1;
  const exponentMarker = text[probe];
  if (exponentMarker === 'e' || exponentMarker === 'E') {
    probe += 1;
    index = probe;
    consumeSign();
    if (!consumeDigitsWithSeparators()) index = beforeExponent;
  } else if (exponentMarker === '×' || exponentMarker === 'x' || exponentMarker === '*') {
    probe += 1;
    while (text[probe] === ' ') probe += 1;
    if (text[probe] === '1' && text[probe + 1] === '0') {
      probe += 2;
      while (text[probe] === ' ') probe += 1;
      if (text[probe] === '^') {
        probe += 1;
        while (text[probe] === ' ') probe += 1;
        index = probe;
        consumeSign();
        if (!consumeDigitsWithSeparators()) index = beforeExponent;
      }
    }
  }

  return { value: text.slice(0, index).trim(), unit: text.slice(index).trim() };
}

/**
 * Separators are stripped only when the whole value is unambiguously grouped —
 * one to three leading digits, then runs of exactly three, and nothing else.
 * All or nothing, never separator by separator.
 *
 * Removing any separator that merely sits between digits would delete the
 * comma in `1,5`, where some locales mean one and a half, and award `15` — a
 * fifteen-fold error scored as correct. Stripping per separator is no better:
 * on two-digit Indian grouping (`1,23,456`) it removes the second comma and
 * not the first, producing `1,23456`, a number nobody wrote.
 *
 * So `1,23,456` is left exactly as typed. It then fails to parse, the slot
 * falls through to the terminal rule and awards 0 — a mark not gained rather
 * than a value the learner never entered being marked right (ADR-0003). The
 * same holds for a grouped value carrying an exponent or a fraction bar.
 */
const GROUPED_NUMBER = /^[+-]?\d{1,3}(?:[, ]\d{3})+(?:\.\d+)?$/u;

function stripGrouping(value: string): string {
  return GROUPED_NUMBER.test(value) ? value.replaceAll(',', '').replaceAll(' ', '') : value;
}

export function normalizeNumericEntry(
  raw: string,
  flags: NormalizationFlags,
): Result<NormalizedEntry, NormalizeError> {
  if (raw.length === 0) {
    return err(validationError('ENTRY_EMPTY', 'the entry is empty'));
  }

  let text = raw;

  if (flags.trimWhitespace) {
    text = text.replace(EXOTIC_SPACE, ' ').trim();
  }

  if (flags.unicodeMinusToAscii) {
    text = text.replace(MINUS_LIKE, '-');
  }

  if (text.trim().length === 0) {
    return err(validationError('ENTRY_EMPTY', 'the entry is empty'));
  }

  const { value, unit } = splitValueAndUnit(text);

  if (value.length === 0) {
    return err(
      validationError('NO_NUMERIC_VALUE', `"${raw}" carries no numeric value`),
    );
  }

  const separated = flags.stripThousandsSeparator ? stripGrouping(value) : value;
  const casedUnit = flags.caseInsensitiveUnit ? unit.toLowerCase() : unit;

  return ok(Object.freeze({ value: separated, unit: casedUnit }));
}
