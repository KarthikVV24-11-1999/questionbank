/**
 * What an outbox payload may carry (DATA-ARCHITECTURE P4, D17): **identifiers and version numbers only** — never a stem, a
 * key, a solution body or a reviewer's justification. The outbox drains to analytics, which is exactly where none of those
 * may arrive.
 *
 * Until the relay existed the discipline was a convention each event's author kept and a fitness rule checked in each
 * context's event declarations. The relay is the first thing that *moves* a payload anywhere, so it is the place the
 * discipline is enforced as a gate: a message that breaks it is not delivered to any consumer. It is dead-lettered with the
 * reason, where an operator can see it, and the event that produced it is a defect to fix at its source.
 *
 * Two checks, because each catches what the other misses:
 *
 *   - **by name** — a field that is the key, names the key, or is where a stem, a solution or a justification lives, at any
 *     depth. Enumerated, so a field a spread carried in by accident is still caught by its name.
 *   - **by shape** — a string that is prose rather than an identifier, a code or a timestamp: long, or spanning lines.
 *     This is what catches a stem, a solution or a justification sent under a field name nobody listed.
 */
export const FORBIDDEN_PAYLOAD_FIELDS: readonly string[] = Object.freeze([
  // the key, and everything that names it (content's own list, restated: platform imports no context; a spec holds the two equal)
  'answerKey',
  'answer_key',
  'correctOptionId',
  'correctOptionIds',
  'isCorrect',
  'is_correct',
  'expectedValue',
  'toleranceValue',
  'rangeMin',
  'rangeMax',
  'significantFigures',
  'finalAnswerAssertion',
  // where a stem, an option or a solution lives
  'stem',
  'body',
  'content',
  'options',
  'responseSpec',
  'solution',
  'solutionBody',
  'steps',
  'explanation',
  'distractorAnalyses',
  'misconception',
  // a reviewer's or an operator's words
  'justification',
  'comment',
  'notes',
  // a learner's answer is the response log's, not an event's
  'answer',
  'answers',
]);

/** The longest string an identifier, a code, a decimal or a timestamp could be; anything longer is prose. */
export const MAX_PAYLOAD_STRING_LENGTH = 200;

export interface PayloadViolation {
  readonly path: string;
  readonly reason: 'forbidden-field' | 'prose';
}

/** Every way `payload` breaks the discipline, by path. Empty when it keeps it. */
export function checkPayloadDiscipline(payload: unknown, path = '$'): PayloadViolation[] {
  if (typeof payload === 'string') {
    return payload.length > MAX_PAYLOAD_STRING_LENGTH || /[\r\n]/u.test(payload) ? [{ path, reason: 'prose' }] : [];
  }
  if (Array.isArray(payload)) return payload.flatMap((element, index) => checkPayloadDiscipline(element, `${path}[${index}]`));
  if (typeof payload === 'object' && payload !== null) {
    return Object.entries(payload).flatMap(([key, value]) => [
      ...(FORBIDDEN_PAYLOAD_FIELDS.includes(key) ? [{ path: `${path}.${key}`, reason: 'forbidden-field' as const }] : []),
      ...checkPayloadDiscipline(value, `${path}.${key}`),
    ]);
  }
  return [];
}
