# ADR-0021 — Duplicate detection is advisory, and reports three labelled groups
Status: Accepted
Date: 2026-08-26

## Context

ROADMAP's fifth M4 acceptance criterion is **"duplicate detection catches
same-question-different-constants"** — the disguise that matters most in an exam bank, where the
same physics problem reappears with the mass changed from 4 kg to 9 kg and nothing else touched.

Two questions had to be settled before any of it could be built.

**First: is a duplicate verdict blocking?** The tempting answer is yes — refuse to publish an
item the system believes is a duplicate. It is also wrong, and expensively so. Duplicate
detection is a *similarity* judgement over natural language and mathematics. A false positive
that blocks publication is an author unable to ship a legitimately distinct item, with no
override that is not itself a hole; a false negative that was trusted as a verdict is worse,
because it launders "we did not detect one" into "there is not one".

**Second: is the answer one score, or several findings?** A single ranked list is what a
similarity search naturally produces. But a rank-10 trigram neighbour and a byte-identical retype
are not the same finding, and collapsing them into one list forces the reviewer to re-derive the
distinction from a number.

## Decision

**Duplicate detection is advisory, never blocking, and it reports three separately labelled
groups rather than one merged list.**

### Advisory, structurally

`GetDuplicateCandidates` is a **query with no caller among content's transition handlers**, and
that is asserted by import graph in `fitness/content-rules.ts` — the same discipline
`delivery-queries.ts` gets for the answer key. No publication precondition consults it. No
lifecycle transition reads it. A reviewer sees the finding and decides; the software does not
decide for them.

The reviewer's own judgement is captured instead: `DUPLICATE` is a rejection reason
(DEC-M4-11) that **requires `duplicateOfItemId`** — a reviewer calling something a duplicate must
say what of. That is a human verdict with a citation, which is a different and better artifact
than a machine verdict with a score.

### Three groups, three questions

| Group | Question it answers | How |
|---|---|---|
| `exactMatches` | "Is this the same item, retyped?" | `exactHash` — normalized text, options in authored order |
| `skeletonMatches` | "Is this the same question with different constants?" | `skeletonHash` — same normalization, then every numeric literal and the unit token following it collapsed to a placeholder, and MCQ options sorted by their own normalized text |
| `trigramMatches` | "Is this merely similar?" | trigram similarity, ranked, capped |

**`skeletonHash` is DEC-M4-2's definition of "same question, different constants", not an
approximation of it.** Sorting the options before hashing is deliberate: re-ordering options is
the cheapest possible disguise, and a skeleton that changed under it would miss the case the
ROADMAP criterion names.

**Similarity is shown only in the trigram group.** Exact and skeleton membership is binary — an
item either has the same hash or it does not — and attaching a score to a binary fact invites
reading it as a confidence.

### Honest absence

When no fingerprint has been computed for a version yet, the result is `state: 'not_evaluated'`
with empty groups — never `evaluated` with nothing in it. "We have not looked" and "we looked and
found nothing" are different answers, and the workspace renders them differently. The claim path
computes a missing fingerprint synchronously (`ClaimNextForReviewHandler.ensureFingerprint`), and
`RefreshFingerprints` is the batch path for everything else.

That synchronous computation is itself advisory: it runs **after** the claim's transaction has
committed, and every one of its failure branches gives up quietly and returns the claim. A claim
a reviewer already holds must never disappear because a hash could not be computed.

## Consequences

**Proven against a planted corpus, not against itself.** `apps/api/src/testing/review/corpus-40.ts`
plants a constants-swapped pair, an exact retype and a near-miss, each asserted by exactly one
test against the real repositories — and the constants-swapped case carries a planted failure
proving the suite goes red if the skeleton hash stops pairing it. A detector tested only on
inputs it was designed around proves nothing.

**Recall is widened, precision is not claimed.** The trigram path is narrowed by a GIN index when
`pg_trgm` is installed and by a full subject scan when it is not; both paths score and rank
identically in-repo, so the index changes which rows are considered, never the answer.

**What this does not give you.** No cross-subject detection — every lookup is subject-scoped, so
the same question filed under two subjects is not paired. No semantic similarity: a question
reworded entirely, with different numbers and different vocabulary, is not caught by any of the
three groups. Both are consequences of choosing hashes and trigrams over embeddings, which is a
choice about explainability — a reviewer can be told exactly why two items paired.
