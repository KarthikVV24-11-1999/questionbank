import { join } from 'node:path';
import { readCode } from './source-scan.js';

/**
 * **A practice submission is scored without a form, and a consumer written for papers never receives one** (M8-25, ADR-0061).
 *
 * The strongest thing that can be checked from source is weaker than that sentence, and this file says so rather than claim it. It cannot show that a submitted run is scored: that is
 * `practice-loop.integration.spec.ts`, which drives the real application, the real relay and the real consumers to a score record and to Learning's evidence. What source can show is the wiring
 * that makes the two paths unable to be confused, and that nothing was dropped when a type was added. Five things:
 *
 *   1. **The run's event names no form.** `PracticeAttemptSubmitted`'s payload declares no `formId` (and no section, which a run does not have either): the field that a consumer for papers dereferences is
 *      not there to be wrongly read.
 *   2. **The paper's event keeps its form.** `AttemptSubmitted` still declares a required `formId` and `schemaVersion: 1`. A nullable form and a bumped version were the other way to do this, and are the one
 *      this file exists to keep from happening by drift.
 *   3. **Every declared event has a consumer.** Each name in `ASSESSMENT_EVENT_TYPES` is a key of the relay's map in `assessment/public/composition.ts`. A type added without one sits in the outbox
 *      for ever, undelivered and unremarked, which is how "an attempt nothing ever scores" is made.
 *   4. **No two types share a consumer.** The relay's map gives each type its own, so a mock's consumer cannot be handed a run by a line that registers it twice.
 *   5. **The consumer for runs reads no form.** `practice-scoring-consumer.ts` names no form repository and imports nothing of the form: a run has none, and a read of one would be a read of the wrong attempt.
 *
 * What stays outside: that the consumer fills a run's slots with what the profile pays and not with something else is a behaviour, held by its unit spec and by the integration spec, and a rule that
 * claimed it from source would be reading comments.
 */
export interface PracticeViolation {
  readonly rule: 'M8_25_PRACTICE_EVENT_NAMES_A_FORM' | 'M8_25_PAPER_EVENT_LOST_ITS_FORM' | 'M8_25_EVENT_WITHOUT_A_CONSUMER' | 'M8_25_CONSUMER_SHARED_BY_TWO_TYPES' | 'M8_25_PRACTICE_CONSUMER_READS_A_FORM';
  readonly file: string;
  readonly message: string;
}

export const PRACTICE_PATH = {
  events: 'src/contexts/assessment/domain/events/assessment-events.ts',
  composition: 'src/contexts/assessment/public/composition.ts',
  consumer: 'src/contexts/assessment/application/consumers/practice-scoring-consumer.ts',
} as const;

/** The text between the braces of `interface <name>`, or `null` when there is none. */
function interfaceBody(code: string, name: string): string | null {
  const start = new RegExp(`interface\\s+${name}\\b[^{]*\\{`, 'u').exec(code);
  if (start === null) return null;
  let depth = 1;
  for (let index = start.index + start[0].length; index < code.length; index += 1) {
    if (code[index] === '{') depth += 1;
    if (code[index] === '}') depth -= 1;
    if (depth === 0) return code.slice(start.index + start[0].length, index);
  }
  return null;
}

export function checkPracticePath(root: string, options: { readonly events?: string; readonly composition?: string; readonly consumer?: string } = {}): PracticeViolation[] {
  const events = options.events ?? PRACTICE_PATH.events;
  const composition = options.composition ?? PRACTICE_PATH.composition;
  const consumer = options.consumer ?? PRACTICE_PATH.consumer;
  const violations: PracticeViolation[] = [];

  const eventCode = readCode(join(root, events));
  const practice = interfaceBody(eventCode, 'PracticeAttemptSubmitted');
  if (practice === null || /\bformId\b|\bsection\w*\b/u.test(practice)) {
    violations.push({ rule: 'M8_25_PRACTICE_EVENT_NAMES_A_FORM', file: events, message: `${events}: PracticeAttemptSubmitted is declared with no form and no section in it; a run has neither (ADR-0061)` });
  }
  const paper = interfaceBody(eventCode, 'AttemptSubmitted');
  if (paper === null || !/readonly\s+formId\s*:\s*string\s*;/u.test(paper) || !/readonly\s+schemaVersion\s*:\s*1\s*;/u.test(paper)) {
    violations.push({ rule: 'M8_25_PAPER_EVENT_LOST_ITS_FORM', file: events, message: `${events}: AttemptSubmitted keeps a required formId and schemaVersion 1; a paper's consumer reads it (ADR-0061)` });
  }

  const declared = [...(/ASSESSMENT_EVENT_TYPES\s*=\s*\[([^\]]*)\]/u.exec(eventCode)?.[1] ?? '').matchAll(/'([A-Za-z]+)'/gu)].map((match) => match[1]!);
  const compositionCode = readCode(join(root, composition));
  const registered = [...compositionCode.matchAll(/\[\s*'([A-Za-z]+)'\s*,\s*\[\s*([A-Za-z_$][\w$]*)\s*\]\s*\]/gu)].map((match) => ({ type: match[1]!, consumer: match[2]! }));
  for (const type of declared) {
    if (!registered.some((entry) => entry.type === type)) {
      violations.push({ rule: 'M8_25_EVENT_WITHOUT_A_CONSUMER', file: composition, message: `${composition}: ${type} is declared in ASSESSMENT_EVENT_TYPES and no consumer is registered for it, so it would sit in the outbox undelivered` });
    }
  }
  const seen = new Map<string, string>();
  for (const entry of registered) {
    const other = seen.get(entry.consumer);
    if (other !== undefined && other !== entry.type) {
      violations.push({ rule: 'M8_25_CONSUMER_SHARED_BY_TWO_TYPES', file: composition, message: `${composition}: ${entry.consumer} is registered for ${other} and for ${entry.type}; each type has a consumer of its own` });
    }
    seen.set(entry.consumer, entry.type);
  }

  const consumerCode = readCode(join(root, consumer));
  if (/\bforms\b|FormRepository|domain\/form(?:-package)?\.js/u.test(consumerCode)) {
    violations.push({ rule: 'M8_25_PRACTICE_CONSUMER_READS_A_FORM', file: consumer, message: `${consumer} names a form; a practice run has none to read (ADR-0061)` });
  }
  return violations;
}
