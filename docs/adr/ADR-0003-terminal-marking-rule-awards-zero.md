# ADR-0003 — The terminal `ALWAYS` rule awards zero, never a penalty
Status: Accepted
Date: 2026-08-05
Supersedes: the three-rule JEE Main encoding shipped in M1-07 (commit `4c31a85`)

## Context

ASSESSMENT-ENGINE §2.4 writes the JEE Main / NEET UG marking scheme as three rules:

```
1  UNATTEMPTED   → FIXED   0
2  EXACT_MATCH   → FIXED  +4
3  NO_MATCH      → FIXED  −1
```

F46 requires that a rule set terminate in an `ALWAYS` rule, so that every response has an outcome.
The three rules as written do not.

M1-07 originally resolved this by collapsing rule 3 into the terminal rule: `ALWAYS → −1`, on the
argument that after `UNATTEMPTED` and `EXACT_MATCH` the only remaining case is a wrong answer.

That argument is wrong. It holds only if the response state space is exactly
{unattempted, exact match, no match}. It is not:

- The same profile permits `NUMERIC` items, where evaluation can be indeterminate — an unparseable
  entry, a missing unit under `unit.required`, a tolerance that cannot be applied.
- The condition set is a closed set of eight today and is versioned to grow; M2 evaluates rule sets
  against item types that did not exist when the profile was authored.
- An `ItemOutcome` may arise from a state the authors did not enumerate.

Under `ALWAYS → −1`, every one of those deducts a mark from the candidate.

ENGINEERING-HANDBOOK §8 says "fail closed on scoring". Failing closed means declining to award marks
that cannot be justified — awarding 0. Deducting a mark is not the closed direction; it is an active
penalty for a gap in the engine. §10 asks whether each error path "fails in the correct direction",
and this one did not.

The document's own JEE Advanced set settles it: seven rules ending `ALWAYS → FIXED 0`. Neutral
termination is the authors' convention.

## Decision

Every marking rule set terminates in `ALWAYS` with a neutral award. The JEE Main / NEET UG scheme is
encoded as four rules:

```
1  UNATTEMPTED   → FIXED   0
2  EXACT_MATCH   → FIXED  +4
3  NO_MATCH      → FIXED  −1
4  ALWAYS        → FIXED   0
```

This is the three authored rules of §2.4 plus the terminal rule F46 requires. `NO_MATCH` carries the
penalty, and only a genuine, recognised wrong answer matches it.

## Consequences

The golden hash fixtures changed, which is the point of pinning them — a scoring-semantics change
must be visible as a hash change and reviewed as one:

| Set | Before | After |
|---|---|---|
| `jeeMain` (§2.4 reference, MCQ) | `11b9ca4d…3012` | `048dabf4…1ae6` |
| `jeeMain2026Profile` (MCQ + NUMERIC) | `30460a04…bcaa` | `4fe24605…7a91` |
| `jeeAdvanced` | `556c3c63…d07a` | unchanged |

M1-07's acceptance text says "JEE Main 3-rule set validates". Under F46 the shipped set is four rules;
the third is `NO_MATCH → −1` exactly as §2.4 specifies, and the fourth exists only because F46
demands a terminal `ALWAYS`. No scoring behaviour differs for any anticipated response.

Makes easy: an unanticipated response state costs a candidate nothing; new condition kinds can be
added without silently changing the penalty surface of existing profiles.

Makes hard: nothing. The extra rule is one row of data.

Proof: `apps/api/…/value-objects/marking-rule-set.spec.ts` › "terminates in a neutral award, never a
penalty"; `tools/seed/data/jee-main-2026.profile.spec.ts` and `neet-ug-2026.profile.spec.ts` ›
"never penalises an unanticipated response state".

## Alternatives

**Keep `ALWAYS → −1`.** Rejected: it penalises candidates for engine gaps, and contradicts the
neutral-termination convention the same document section uses for JEE Advanced.

**Amend ASSESSMENT-ENGINE §2.4 to add the terminal rule.** Worth doing, and recorded as debt — the
document should show the F46-complete form so the next reader does not repeat this mistake.
