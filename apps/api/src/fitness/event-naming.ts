/**
 * EVENT-TAXONOMY §2: an event is named `<domain>.<object>_<past_tense_verb>`, past tense only, because events are facts and not intentions.
 *
 * Past tense cannot be detected in general (the catalog has `lost`, `shown`, `sent`, `taken`), so the rule is held the way this repository holds other rules written in prose: the
 * gate reads §3's names, takes the verb each ends in, and requires it to be in the set below. A new event whose verb is not here fails until someone adds it, which is the point:
 * accepting a word as a past-tense fact becomes a decision in a diff and not something nobody noticed.
 */
export const PAST_TENSE_VERBS: ReadonlySet<string> = new Set([
  'abandoned', 'answered', 'cancelled', 'clicked', 'completed', 'crossed', 'decided', 'declared', 'degraded', 'detected', 'dismissed', 'dispositioned', 'drafted', 'entered', 'evaluated',
  'executed', 'exhausted', 'expired', 'failed', 'filed', 'flagged', 'generated', 'interrupted', 'lost', 'measured', 'opened', 'published', 'recovered', 'registered', 'regressed',
  'renewed', 'reported', 'resolved', 'restored', 'retired', 'reviewed', 'selected', 'sent', 'shown', 'skipped', 'started', 'submitted', 'suppressed', 'suspended', 'taken',
  'unflagged', 'verified', 'viewed', 'visited',
  // a verb with its complement: the fact is that it was submitted, and for review
  'submitted_for_review',
]);

/** Names the catalog has that break the rule, each held by a register entry: the gate is green on the real catalog and red on the next one nobody registered. */
export const NAMING_EXCEPTIONS: Readonly<Record<string, { readonly debt: string; readonly because: string }>> = {
  'ai.tutor_turn': { debt: 'D89', because: 'a turn is a noun, not something that happened; the event is unowned and unbuilt' },
  'client.error': { debt: 'D89', because: 'an error is a noun, not something that happened; the event is unowned and unbuilt' },
};

export interface NamingViolation {
  readonly rule: 'NAME_SHAPE' | 'NOT_A_PAST_TENSE_FACT' | 'EXCEPTION_NOT_IN_CATALOG' | 'EXCEPTION_NOT_NEEDED' | 'EXCEPTION_NOT_REGISTERED';
  readonly name: string;
  readonly detail: string;
}

const SHAPE = /^[a-z]+(?:_[a-z]+)*\.[a-z]+(?:_[a-z]+)*$/u;

/** Whether the object part of a name ends in an accepted verb, as a whole word: `bar_started` does, `bar_restarted` does not. */
function endsInAcceptedVerb(name: string, accepted: ReadonlySet<string>): boolean {
  const object = name.slice(name.indexOf('.') + 1);
  return [...accepted].some((verb) => object === verb || object.endsWith(`_${verb}`));
}

export function checkNaming(
  names: readonly string[],
  debtDocument: string,
  accepted: ReadonlySet<string> = PAST_TENSE_VERBS,
  exceptions: Readonly<Record<string, { readonly debt: string; readonly because: string }>> = NAMING_EXCEPTIONS,
): NamingViolation[] {
  const violations: NamingViolation[] = [];
  const passes = (name: string): boolean => SHAPE.test(name) && endsInAcceptedVerb(name, accepted);
  for (const name of names) {
    if (exceptions[name] !== undefined) continue;
    if (!SHAPE.test(name)) violations.push({ rule: 'NAME_SHAPE', name, detail: 'a name is lower-case words joined by underscores, a dot, and more of the same' });
    else if (!endsInAcceptedVerb(name, accepted)) violations.push({ rule: 'NOT_A_PAST_TENSE_FACT', name, detail: `"${name.split('_').pop()}" is not in the accepted past-tense verbs; add it if it is one, and rename the event if it is not` });
  }
  for (const [name, exception] of Object.entries(exceptions)) {
    if (!names.includes(name)) violations.push({ rule: 'EXCEPTION_NOT_IN_CATALOG', name, detail: 'an exception for an event the catalog no longer has' });
    else if (passes(name)) violations.push({ rule: 'EXCEPTION_NOT_NEEDED', name, detail: 'the name is acceptable without it' });
    if (!new RegExp(`^### ${exception.debt} —`, 'mu').test(debtDocument)) violations.push({ rule: 'EXCEPTION_NOT_REGISTERED', name, detail: `${exception.debt} has no entry in the debt register` });
  }
  return violations;
}
