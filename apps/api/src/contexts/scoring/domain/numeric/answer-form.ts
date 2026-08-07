import type { AnswerForm } from '../answer-key.js';

/**
 * Which of the three accepted forms a normalized value is written in.
 *
 * A form the spec does not accept is **rejected**, never quietly converted.
 * An author who wrote `acceptedForms: [DECIMAL]` was making a statement about
 * what the item is testing — often that converting to a decimal is part of the
 * question — and silently accepting `3/4` would mark a different question.
 */
const SCIENTIFIC_MARKER = /[eE]|[×x*]\s*10\s*\^/u;

export function detectAnswerForm(value: string): AnswerForm {
  if (value.includes('/')) return 'FRACTION';
  if (SCIENTIFIC_MARKER.test(value)) return 'SCIENTIFIC';
  return 'DECIMAL';
}

export function isFormAccepted(form: AnswerForm, acceptedForms: readonly AnswerForm[]): boolean {
  return acceptedForms.includes(form);
}
