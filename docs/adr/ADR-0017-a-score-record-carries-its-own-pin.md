# ADR-0017 — A score record carries its own pin
Status: Accepted
Date: 2026-08-13

## Context

`PostgresScoreRecordRepository` took `examProfileVersionId` and `taxonomyVersionId` at **construction**,
via a `ScoreRecordPersistenceContext`, rather than reading them off the `ScoreRecord` being saved. The
class's own comment explained the choice: *"the profile and taxonomy identifiers are carried alongside the
record rather than on it: they belong to the attempt's pin, and the domain aggregate holds only what a
score is. The repository is where the two meet."* The database columns existed and were `NOT NULL` from
M2's own migration (`20260807100000_scoring_schema.sql`); only the domain type and the read path never
mirrored them.

This surfaced during M0-11, composing scoring's handlers into `contexts/scoring/public/composition.ts`
(ADR-0015). `ScoreAttemptHandler` and every rescoring handler are built **once**, as part of one shared
`HandlerRegistry`, and serve every request that reaches them — but a single `PostgresScoreRecordRepository`
instance, fixed to one profile's context at construction, can only ever be correct for that one profile.
The moment a second exam profile went live, every score computed through that shared instance would have
been written under the wrong profile's identifiers — silently, since nothing about the write or the read
path would object.

**The read side was already blind to this**, independently of composition. `toScoreRecord` (the row → domain
mapper) never read `exam_profile_version_id`/`taxonomy_version_id` off the row, because the domain
`ScoreRecord` had nowhere to put them. `score-record.repository.integration.spec.ts`'s round-trip test —
`expect(loaded).toEqual(record)` — passed because neither `loaded` nor `record` ever carried the fields;
the assertion was real, but the criterion it claimed to prove ("save → load deep-equal") was not fully
checked. This is the same shape of gap `renderer-seam.spec.ts` had for `MediaBlock.caption`: an instrument
that compares two things missing the same thing agrees with itself, not with the world. See
M2's traceability record finding F-7 and the correction recorded in
M2's close-out.

## Decision

**`ScoreRecord` gains `examProfileVersionId` and `taxonomyVersionId`.** Both are required, validated at
construction the same way `scoreRecordId` and `attemptId` already are (`EXAM_PROFILE_VERSION_ID_REQUIRED`,
`TAXONOMY_VERSION_ID_REQUIRED` — blank is refused, never defaulted, never inferred). `createScoreRecord`
takes them as props; `scoreAttempt` supplies them from `input.pin.examProfileVersionId` and
`input.pin.taxonomyVersionId` — the pin the handler already holds, carried the same distance
`markingRuleSetHash` and `ruleSchemaVersion` already travel from the same source. `markSuperseded` carries
them forward automatically, being a spread over the predecessor.

**`PostgresScoreRecordRepository` drops `ScoreRecordPersistenceContext` entirely.** Its constructor takes
only a `Pool`. `insert` writes `record.examProfileVersionId`/`record.taxonomyVersionId` instead of a
captured `this.context`; `toScoreRecord` reads `row.exam_profile_version_id`/`row.taxonomy_version_id` into
the object it returns. One repository instance is now correct for every exam profile, because correctness
no longer depends on which profile it was constructed for.

**A score without its pin is a number without provenance.** Rescoring's `supersede` depends on knowing what
the predecessor was scored under — that is the entire justification for the pin's existence in
DOMAIN-MODEL §7 — and a value that determines the answer's rules but is not part of the answer's own record
is not "context alongside a score," it is a piece of the score the repository's comment was wrong to carry
separately.

## Consequences

**Makes easy:** scoring's composition seam (M0-11) is a single shared `PostgresScoreRecordRepository`
instance, exactly like every other repository in the codebase. No per-profile factory, no per-request
construction, no special case in `platform/composition/` (M0-12) for the one repository that used to need
one.

**Makes hard:** nothing new. The database already carried both columns as `NOT NULL`; this closes a gap
between the schema and the domain type that should never have existed, rather than opening one.

**Forecloses nothing.** `ScoreRecordRepository` (the port) did not change — `save(record)` and
`supersede(predecessorId, successor, …)` have the same signatures they always did. Every caller of the port
is unaffected; only the concrete Postgres adapter's constructor and internals changed.

**Coverage.** `score-record.ts`, `score-attempt.ts` and `score-record.repository.ts` stay at 100% —
the two new validation branches and the two new read/write paths are covered, proven failing first by
temporarily reintroducing the dropped field on each side (read, then write) and confirming the strengthened
round-trip test — now asserting `examProfileVersionId`/`taxonomyVersionId` by name, not only via the
blanket `toEqual` — catches each independently, then reverting.

**Golden set:** 40 pass, 0 official papers, 4 synthetic — unchanged from before this change. The pin travels
with the record; it does not change what any rule computes.

## Alternatives

**A per-call context parameter on `save`/`supersede`.** Rejected: the port's signature would have to change
for every caller, and the parameter would just be re-deriving `record.examProfileVersionId` from the same
`ScoringInput.pin` the handler already read to build the record in the first place — passing the same fact
twice, once correctly attached to the aggregate and once loose, is the redundancy this ADR removes rather
than relocates.

**A repository factory constructing one `PostgresScoreRecordRepository` per exam profile.** Rejected: it
solves the composition-time problem by moving it to request time — something still has to route a request
to the right factory output by profile, which means either the handler now knows about profiles (it
should not) or the factory guesses from data on the command that, again, belongs on the record it is about
to build. It also multiplies repository instances for no operational benefit, since the SQL and the pool
are identical across all of them.

**Hardcode one profile's identifiers at composition time, accepting the limitation until multiple profiles
are live.** Rejected outright, not merely as an inferior option: this is silently wrong, not incompletely
right. ADR-0008 holds scoring's domain to 100% coverage on the argument that a bug here "looks right, passes
review, and is worse than a crash" — a hardcoded profile ID is exactly that shape of bug, engineered in on
purpose, the day a second profile ships.
