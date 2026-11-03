# ADR-0060 — The learner profile is Learning's, and a declared scope narrows practice and never a mock

**Status** Accepted · M8 Track E, M8-18 to M8-22 · Records DEC-M8-9, DEC-M8-10, DEC-M8-11 and DEC-M8-12 (docs/IMPLEMENTATION-DECISIONS.md)

## Context

FR-STU-01 asks for a learner's target exam, year, class and prior score, taken in steps the learner can leave and come back to or skip. FR-STU-02 asks for a record of what they have studied, applied to practice and recommendations and never to a mock exam. Something has
to own that record, and the rule about mocks has to be held somewhere stronger than a sentence.

## Decision

**Learning owns the profile** (DEC-M8-9). The profile exists to constrain and steer practice and recommendations, and Learning is the context that decides what a learner is asked to do next. Identity owns credentials, sessions and roles, and a product profile in its tables would
make every change to onboarding a change to the context that guards sign-in. An eighth bounded context for one aggregate is overbuilding. The profile is keyed on identity's user id with no foreign key into its tables, so the contexts keep sharing nothing but the id.

The profile references Curriculum's exam profile version and taxonomy version and records the versions it was built against. It copies neither (INV-04). Learning reaches Curriculum through a seam the root fills, as it reaches Scoring and Content, and `learning-rules.ts`
forbids the direct import in both directions.

**Partial is a valid state from the start.** Every field may be absent. Where a learner was is read from what the profile holds, never from a stored step marker, so there is no marker to disagree with the fields. The order is exam, class, coverage; the prior score is optional and is never
the next step.

**A scope is declared against one taxonomy version and applies only to that version** (DEC-M8-10). After a new version is published the stored scope is not carried across by guesswork and not deleted: it is reported as needing review, and it filters nothing. Editing the scope
resolves the exam again first, refreshes the versions the profile holds, and declares against the current one. A scope that cannot be read means practice carries on unfiltered; a profile that is down is never the reason a learner cannot practise.

**Scope is applied to practice and recommendation reads, and to nothing else.** The assessment handlers are composed from one dependency bag, so the scope source is offered to the mock handlers too, and the type system does not stop them from looking. Two things hold it. A fitness rule
(`scope-rules.ts`) fails the build when any Assessment file outside the five that carry the scope to practice names it. That is a static reachability rule and says nothing about what one of those five does with the value, so a behavioural spec composes a mock beside a scope source that would
exclude most of the paper and shows it delivered whole and the source never asked. The rule is proved red against a planted file.

**Onboarding is skippable, never blocks, and asks for no payment** (DEC-M8-11). Skipping is recorded and reversible: choosing anything afterwards clears it. Nothing the learner reaches afterwards asks for an exam, a class or a scope, and a spec skips everything and then reads the review plan,
the remediation concepts, the notebook and starts a practice run. No step of onboarding asks for payment. That is written here so it stays true when payment arrives in M9: a plan is offered after onboarding, from the product, and never as a step of it.

**The learner app keeps an unsent answer on the device** (DEC-M8-12). A step is written to the device and then sent, and the draft is removed when the server has it; the store is the response log's database, not `localStorage`. With no connection the class and a past score still work; the exam and the chapters need the server's lists (D109). Leaving is a link to the product on every question, and it goes even when the skip cannot be recorded.

**Every step is limited.** The profile routes pass through an admission in Learning, on the port Track B built, with limits in configuration (`RATE_LIMIT_PROFILE`). Learning holds a small copy of identity's admission rather than reaching for the platform, because a context may import only the
role vocabulary from `platform` (ADR-0026).

## Consequences

**Makes easy:** a new onboarding step is a field and an entry in the derived state; a new place that wants the scope is one more file in the rule's list, added in the same change, where a reviewer sees it.

**Makes hard:** the per-context admission is a copy, kept honest by a spec that assigns the platform's limiter to Learning's port. The mock invariant is held by a rule and a behavioural spec, not by the compiler.

**Not done,** and entered as debt: `onboarding.abandoned` is in the catalog and nothing can emit it, because nothing knows a learner has left (D108 in docs/DEBT.md); and the exam and chapter lists are not kept on the device, so those two questions need a connection (D109 in docs/DEBT.md).
