# AI Architecture
**Version:** 0.1 · **Date:** 2026-08-05 · **Status:** Draft
**Traces to:** [FRS.md](FRS.md) §11 · [NFR.md](NFR.md) §16 · [DOMAIN-MODEL.md](DOMAIN-MODEL.md) §10 · [BACKEND-ARCHITECTURE.md](BACKEND-ARCHITECTURE.md) §11
**Phase:** 4 — AI Architecture

> One recommendation per decision, one line of justification. No implementation.

---

## 1. Architectural Stance

**The AI system's job is not to generate questions. It is to maximize verified content per reviewer-hour.**

Reviewer capacity is the binding constraint (R12), not model capability and not inference cost. The economics make this concrete:

| Cost component | Per published item | Basis |
|---|---|---|
| Generation inference | ~₹1.9 / candidate | Batch API (50% off) + cached grounding prefix |
| Verification inference | ~₹2.6 / candidate | Two independent solves at Opus-tier |
| Pre-checks | ~₹0.3 / candidate | Deterministic + Haiku-tier classification |
| **Inference subtotal @ 60% acceptance** | **~₹8** | 1.67 candidates paid per item published |
| **Reviewer time @ 60% acceptance** | **~₹42** | 60 items/hr at SME rates, including rejected candidates |

**Reviewer time costs 5× the inference.** Raising first-pass acceptance from 60% → 80% saves ₹11 in reviewer time and ₹2 in inference. Every design decision below is evaluated against acceptance rate first and token cost second.

**Second stance: most of these twelve capabilities should not call an LLM at runtime.** Difficulty estimation, duplicate detection, semantic search, and recommendation are better served by embeddings, statistics, and classical methods. Only generation, explanation, hints, and validation genuinely need a frontier model — and all four run offline, at content-creation time. This is what makes CST-06 (zero live AI inference on the free tier) achievable rather than aspirational.

---

## 2. Model & Capability Routing

| Capability | Model / method | Justification |
|---|---|---|
| Item generation | **Claude Opus 5** (`claude-opus-5`) | Correctness of physics/chemistry/math content is the product; a cheaper model that raises rejection rate costs more in reviewer time than it saves in tokens. |
| Independent answer verification | **Claude Opus 5**, separate call | The safety-critical path — it must be at least as capable as the generator or it rubber-stamps. |
| Symbolic verification (where the item permits) | **CAS (SymPy), not an LLM** | Deterministic beats probabilistic; a computer algebra system does not agree with itself out of politeness. |
| Solution & distractor generation | **Claude Opus 5** | Distractor analysis is the highest-value explanatory content and the hardest to get right. |
| Hint generation | **Claude Sonnet 5** | Pre-generated, reviewed, then cached forever — quality matters, but the ceiling is lower than for correctness. |
| Tag suggestion, scope conformance, clarity checks | **Claude Haiku 4.5** | Classification tasks with a fixed label set. |
| Moderation triage | **Claude Haiku 4.5** | High volume, human-decided outcome. |
| AI tutor *(H1)* | **Claude Sonnet 5**, streaming | The only interactive path; latency matters more than the last increment of capability. |
| **Difficulty estimation** | **Feature model + empirical p-value — no LLM at runtime** | An LLM asked to "rate this 1–5" produces noise; solution-step count and prerequisite depth are real signal. |
| **Duplicate detection** | **Normalized hash + trigram + embedding cosine** | Three cheap signals fused beat one expensive judgment. |
| **Semantic search** | **Embeddings + RRF, no generation** | Retrieval is a vector problem, not a reasoning problem. |
| **Recommendation** | **Rules + scoring, no LLM** | FR-STU-05 requires every recommendation to state *why* — explainability is structural only if the algorithm is the explanation. |

**No fine-tuning in v1.** The corpus is too small, the evaluation infrastructure isn't mature, and grounded prompting captures most of the value. Revisit past 100K reviewed items.

---

## 3. Grounding & Retrieval

Ungrounded generation from a bare concept name is prohibited — it produces plausible questions that drift out of syllabus scope and repeat the same three archetypes.

| Decision | Justification |
|---|---|
| Every generation request retrieves: the concept node, its prerequisite chain, the official syllabus scope text, and *k* exemplar published items with solutions | The model needs to see what "a JEE Main question on this concept" actually looks like, not infer it. |
| Exemplars selected for **difficulty and archetype diversity**, not similarity | Retrieving the 5 nearest neighbours produces 10 paraphrases of those 5. |
| Retrieval uses the same hybrid search that serves students (§9) | One retrieval system, exercised constantly, rather than a second one that silently rots. |
| Grounding block is assembled **identically for every candidate in a batch** | It becomes the cached prefix — see §16. |
| Negative grounding: recently rejected candidates for this concept are included as "do not produce these" | Rejection reasons are the highest-signal training data available, and they are free. |

---

## 4. Question Generation

| Decision | Justification |
|---|---|
| **Batch generation per concept**, 10–20 candidates per run | Amortizes the grounding prefix across the batch and matches how reviewers actually work (§13). |
| **Structured output** (`output_config.format` with a JSON schema) mapping directly to `ItemVersion` fields | Eliminates a parsing layer and makes malformed output an API-level impossibility rather than a runtime error. |
| Explicit **cognitive-operation variation** across a batch (recall / application / multi-step / trap-detection) | Without it, a batch of 15 is three questions and twelve rewordings. |
| Item and solution generated **together**, verified **separately** | Coherence comes from joint generation; safety comes from independent checking. |
| Numeric items must emit a complete `NumericAnswerSpec` (D-001) — tolerance, unit, accepted forms | An item missing a tolerance is unpublishable (FR-TCH-07); catching it at generation is free, catching it at review costs reviewer minutes. |
| `max_tokens` sized for thinking **plus** output | Thinking is on by default on Opus 5 and counts against the cap — an undersized budget truncates mid-item. |
| Generation runs at **`effort: "high"`**, verification at **`"xhigh"`** | Verification is where correctness is decided; it gets the deeper reasoning budget. |
| Every candidate carries model version, prompt version, run ID, and confidence | FR-AI-08 — "which items came from prompt v7?" must be an index scan. |

---

## 5. Explanation Generation

| Decision | Justification |
|---|---|
| Solutions generated **only after** the item passes answer verification | Explaining an item with a wrong key produces a confidently wrong explanation — the worst possible artifact. |
| The solution must **independently reconstruct** the final answer; mismatch is automatic rejection | A solution that doesn't reach the item's key is evidence one of them is wrong. |
| Structured into steps, final-answer assertion, alternate approach, and per-distractor analysis | Maps 1:1 onto the `Solution` aggregate; no post-hoc parsing of prose. |
| **Per-distractor misconception analysis is mandatory**, not optional | This is the single highest-value output in the pipeline (FR-PRA-04) and the thing incumbents do not have. |
| Distractor analysis regenerated once empirical selection data exists | The misconception a model predicts and the one students actually hold are different questions; empirical data settles it. |
| Alternate approaches generated only where genuinely distinct | Three trivially-different algebraic routes is padding that reviewers must read. |

---

## 6. Hint Generation

| Decision | Justification |
|---|---|
| **Three fixed tiers**: L1 notice-this, L2 which-method, L3 first-step. **Never the answer.** | An undifferentiated "hint" collapses into the solution and destroys the effort gate. |
| Hints are **pre-generated at publication and cached permanently** — never live inference | This is what makes hints viable on the free tier under CST-06; a hint is content, not a conversation. |
| Reviewed as part of the solution package, not separately | Hints are cheap to check alongside the solution and expensive to route as their own queue item. |
| Hint reveal is gated on attempt or explicit skip, same as solutions | A hint available before engagement is just a shorter solution. |
| L3 must not contain the final numeric answer or correct option | Enforced as a pre-check, because a model will occasionally give it away. |

---

## 7. Difficulty Estimation

Three stages, each superseding the last.

| Stage | Method | When |
|---|---|---|
| **1. Prior** | Feature-based: solution step count, prerequisite depth, notation complexity, distractor plausibility, comparable-item difficulty | At creation, before any exposure |
| **2. Refined** | Same features + reviewer's estimate, regressed against known-difficulty items | Once the golden set has enough labelled data |
| **3. Empirical** | p-value + discrimination from real responses | Above the exposure threshold (FR-QM-09) |

| Decision | Justification |
|---|---|
| **No LLM difficulty rating at runtime** | A model asked to score difficulty on a 5-point scale produces confident noise; solution length and prerequisite depth are measurable and predictive. |
| Empirical always supersedes; the prior is never re-asserted | Reality beats estimation the moment reality is available. |
| **Prior-vs-empirical divergence is tracked as a model quality metric** | It is a free, continuously-generated calibration signal that costs nothing to collect. |
| Difficulty is a band, not a scalar | False precision on a noisy estimate invites misuse downstream. |

---

## 8. Duplicate Detection

| Decision | Justification |
|---|---|
| **Three fused signals**: normalized-text hash, trigram similarity, embedding cosine | Each catches a different duplicate mode; none is sufficient alone. |
| **Numbers normalized to placeholders before hashing** | The dominant duplicate mode in this domain is the same question with different constants — invisible to every other method. |
| Structural fingerprint: concept set + item type + answer form | Catches semantic duplicates that share no vocabulary. |
| **Advisory, never auto-blocking** | Genuine variants are pedagogically valuable; auto-rejecting them would strip the bank of its difficulty ladders. |
| Reviewer sees candidates **side by side**, not as a similarity score | A number the reviewer must interpret is worse than the two items they can compare in two seconds. |
| Confirmed duplicates are linked; the weaker is retired with a pointer | Preserves history and prevents the same pair being re-adjudicated later. |
| Runs at authoring, at import, and on every AI candidate | Three entry points, one gate. |

---

## 9. Semantic Search

| Decision | Justification |
|---|---|
| Hybrid **reciprocal rank fusion** of lexical and vector results | Lexical misses paraphrase; semantic misses exact notation — math content needs both. |
| **Multi-vector**: stem embedding and concept-context embedding stored separately | "Find similar questions" and "find questions about this concept" are different queries. |
| Symbolic notation extracted into its own lexeme field before embedding | `∫x²dx` must be a term, not a rendering artifact. |
| Embeddings stored in `content_embedding`, versioned by embedding model, regenerated on version change | Derived, recomputable, and deliberately kept off the hot content table. |
| Dual-index during model transition, then atomic cutover | A backfill must not blank search for its duration. |
| Serves both students and the grounding retriever (§3) | One system, continuously exercised. |

---

## 10. Recommendation Engine

| Decision | Justification |
|---|---|
| **Rules and scoring — no LLM** | FR-STU-05 requires every recommendation to state its reason; when the algorithm *is* the reason, explainability is free and cannot drift. |
| Candidate generation from four sources: weak concepts, prerequisite gaps, overdue spaced reviews, uncovered high-weight concepts | Covers the four genuinely different reasons to study something next. |
| Ranked by **estimated mark impact** = exam weight × (1 − mastery) × improvability | Ranking by weakness alone sends students to low-yield concepts; ranking by exam weight alone ignores what they already know. |
| Overdue spaced reviews outrank new material | Retention lost is more expensive than coverage delayed. |
| Every recommendation carries its rationale as structured data | Rendering the reason is then a UI concern, not a generation step. |
| Adaptive selection *(H1)* consumes IRT parameters through the same interface | The scoring function changes; the contract does not (EXT-11). |

---

## 11. Question Validation — The Pre-Check Battery

Twelve checks. **Blocking for AI-generated content, advisory for human-authored.** A candidate that fails any blocking check never reaches a reviewer.

| # | Check | Method | Blocks |
|---|---|---|---|
| 1 | Schema and structural validity | Deterministic | ✅ |
| 2 | Renderability across all surfaces | Deterministic render pass | ✅ |
| 3 | **Independent answer verification** | CAS where symbolic; otherwise 2 independent Opus 5 solves, unanimous agreement required | ✅ |
| 4 | Numeric spec completeness (tolerance, unit, forms) | Deterministic | ✅ |
| 5 | Syllabus scope conformance | Concept membership + Haiku classification | ✅ |
| 6 | Item ↔ solution ↔ key consistency | Opus 5 cross-check | ✅ |
| 7 | Distractor validity — each wrong, plausible, distinct | Opus 5 | ✅ |
| 8 | Duplicate detection | §8 | ⚠️ Advisory |
| 9 | Difficulty plausibility vs. requested band | §7 prior | ⚠️ Advisory |
| 10 | Ambiguity and clarity | Haiku 4.5 | ⚠️ Advisory |
| 11 | Safety and appropriateness | Haiku 4.5 | ✅ |
| 12 | Provenance and licensing completeness | Deterministic | ✅ |

| Decision | Justification |
|---|---|
| **Verification uses a derivation path independent of generation** — different prompt, no sight of the claimed key, solving cold | A model checking its own work agrees with itself. |
| **Disagreement auto-rejects; it never escalates to a human** | Routing uncertain candidates to reviewers is precisely what destroys throughput — the constraint this whole architecture exists to protect. |
| CAS verification preferred wherever the item permits | Deterministic verification is both cheaper and stronger than a second opinion. |
| Pre-check results are visible to the reviewer for accepted candidates | The reviewer should see the verification's working, not just its verdict. |
| Failed checks feed the rejection taxonomy that drives prompt improvement | The battery is also the pipeline's primary telemetry. |

---

## 12. Moderation Workflow

| Decision | Justification |
|---|---|
| **Content moderation and content correctness are separate pipelines** | "Is this appropriate?" and "is this right?" have different reviewers, different SLAs, and different consequences. |
| AI triage classifies, groups, and prioritizes reports — **never decides** | FR-MOD rules require a human decision; automation earns its place by ordering the queue, not by acting. |
| Duplicate reports on the same target collapse into one case | Volume raises priority; it should not multiply work. |
| Tutor output *(H1)* is grounded-checked before display and refuses when ungrounded | An ungrounded claim about exam content is the tutor's worst failure mode. |
| Suspected content defects raised by the tutor route to `ItemDefect` | The tutor sees more items than any reviewer; its observations should reach the pipeline. |
| No AI involvement in sanction decisions | Consequences for students require accountable human judgment. |

---

## 13. Human Review — The Throughput System

The AI pipeline exists to serve this stage. Every choice here targets items reviewed per hour.

| Decision | Justification |
|---|---|
| **Queue batched by concept**, not by arrival time | Context-switching between thermodynamics and organic chemistry is the hidden cost in review throughput. |
| Within a batch, **ordered by confidence, highest first** | Fast early approvals build momentum and calibrate the reviewer's bar before the hard cases arrive. |
| Reviewer sees on one screen: candidate, solution, pre-check results **with rationale**, duplicate candidates, and the grounding exemplars | Anything requiring a second screen or a click costs seconds that multiply by 60/hour. |
| **Single-keystroke decisions** with a fixed rejection taxonomy | Free-text rejection reasons are unanalysable and slow. |
| Approve-with-edits records both versions | Edits are the highest-signal correction data in the system (INV-02). |
| **5% of approvals double-reviewed** | Detects reviewer drift before it reaches students; sustained divergence triggers re-qualification. |
| Tracked per reviewer: items/hour, first-pass acceptance, post-publication defect rate | For capacity planning, never for punitive ranking (C.6). |
| Rejection reasons feed the evaluation set continuously | The reviewer is, incidentally, the best labeller available. |

---

## 14. Evaluation Pipeline

| Decision | Justification |
|---|---|
| **Golden set**: 250 real items with official keys + 100 known-bad negative controls (D-016) | Without negative controls you measure generation quality but never verification sensitivity. |
| Four measured dimensions: generation acceptance, **verification catch rate on known-bad**, explanation quality, difficulty correlation | Each maps to a distinct failure mode; a single aggregate score hides all of them. |
| Explanation quality scored by **LLM-as-judge against a human-calibrated rubric**, with periodic human agreement checks | Human scoring doesn't scale; an uncalibrated judge silently drifts. Both problems are solved by measuring the judge. |
| **Regression blocks promotion — warn is not sufficient** | FR-AI-10; a warning nobody acts on is a quality regression with extra steps. |
| **Shadow evaluation**: new versions run alongside current on real requests, results compared, nothing published | The only honest way to evaluate on the true distribution. |
| Online metrics tracked per version: first-pass acceptance, post-publication defect rate, reviewer minutes per accepted item | Offline eval predicts; online metrics decide. |
| Drift detection on acceptance rate | Silent degradation is the failure mode nobody notices until the corpus is polluted. |
| Golden set grows continuously from rejections and confirmed defects | A static eval set measures yesterday's failures. |

---

## 15. Prompt Management

| Decision | Justification |
|---|---|
| **Prompts authored as files in the repo, published to the database as immutable versions at deploy** | Files give review and diffs; database rows give referential integrity with item provenance. Both are needed. |
| Composed structurally: system → grounding → task → output schema | String concatenation makes the cached prefix boundary accidental rather than designed. |
| **Prompt caching applied to the stable system + grounding prefix** | The single largest cost lever in the pipeline — see §16. |
| Prompt version pinned on every generated artifact | "Prompt v7 had a defect — which items are affected?" must be answerable in one query. |
| Prompt A/B is **shadow evaluation only**, never live on student-visible content | Correctness is not an experiment (C.5). |
| **No student PII in any prompt, ever** | Prompts are logged, cached, and sent to a third party. |
| Model versions pinned explicitly; automatic upgrades prohibited | A silent model change invalidates every quality measurement taken before it. |
| Rollback to any prior version always available | The cheapest incident response is the one that is already built. |

---

## 16. Cost Architecture

### 16.1 The Levers, In Order of Impact

| # | Lever | Effect |
|---|---|---|
| 1 | **Acceptance rate** | Dominates everything: at 60% you pay for 1.67 candidates and 1.67 reviews per published item. Pre-checks are a cost lever before they are a quality lever. |
| 2 | **Batch API** | 50% off all token usage on non-urgent generation — which is all generation. Most batches complete within an hour. |
| 3 | **Prompt caching on the grounding prefix** | Cache reads cost ~0.1× base input; writes cost 1.25× at the 5-minute TTL. Break-even is two requests — a 15-candidate batch is far past it. |
| 4 | **Model routing** | Opus 5 for correctness, Sonnet 5 for hints, Haiku 4.5 for classification. |
| 5 | **Zero live inference on the free tier** | Everything students see is pre-generated and cached (CST-06). |

**Caching constraint worth knowing:** the minimum cacheable prefix differs by model — 512 tokens on Opus 5, 1024 on Sonnet 5, but **4096 on Haiku 4.5**. A ~4,000-token grounding block caches on Opus 5 and silently does not on Haiku. Cached-prefix work is therefore routed to Opus 5 or Sonnet 5, never Haiku.

### 16.2 Governance

| Decision | Justification |
|---|---|
| **Budget checked at enqueue, before dispatch** | Checking after billing is accounting, not governance. |
| Budgets scoped per run, per feature, per user, per period | Different failure modes need different ceilings. |
| Exhaustion halts non-essential AI; core learning is never blocked | AI-12 — AI unavailability must be cosmetic. |
| Cost recorded per run in an append-only ledger at completion | CST-05 measurable daily, not reconstructed monthly. |
| Tracked as first-class SLOs: cost per published item, cost per paid MAU, cost per candidate, acceptance rate | Cost is reviewed monthly with the same seriousness as availability. |

---

## 17. Safety & Failure Modes

| Risk | Mitigation |
|---|---|
| **Plausible-but-wrong content reaching students** (R2) | Mandatory human approval (INV-01) + independent verification + CAS where possible. Zero exceptions, enforced by the context boundary (D8). |
| **Prompt injection via retrieved content** (SEC-20) | Exemplars, student input, and tool results are data, never instructions. The AI Service holds no capability to write Content aggregates, so a successful injection has nothing to reach. |
| **Refusal on legitimate content** | NEET Biology covers human physiology, genetics, and biotechnology — content that can trip bio-category safety classifiers. Handle `stop_reason: "refusal"` before reading content, and enable server-side fallbacks so a declined generation is re-served rather than lost. |
| **Model or provider unavailable** | Queue and retry; no student path depends on live AI (AI-12). |
| **Model deprecation** | Versions pinned as data; migration is a planned operation with mandatory re-evaluation. |
| **Silent quality drift** | Shadow evaluation + acceptance-rate drift detection + per-version defect tracking. |
| **Over-reliance harming learning** (R16) | Hints scaffold in three tiers and never give the answer; solutions are effort-gated; success is measured by verified mastery, not engagement. |
| **Student content used for third-party training** | Contractually prohibited and disclosed (PRI-12). |
| **Hallucinated citations in tutor** *(H1)* | Grounded strictly in published content; refuses rather than asserts when ungrounded. |

---

## 18. AI Fitness Functions

Additions to [ARCHITECTURE.md](ARCHITECTURE.md) §14 and [BACKEND-ARCHITECTURE.md](BACKEND-ARCHITECTURE.md) §16.

| # | Check |
|---|---|
| F27 | No code path writes a `content.*` table from the AI Service |
| F28 | Every generated artifact records model version, prompt version, and run ID |
| F29 | Answer verification uses a distinct prompt version from generation |
| F30 | No prompt template contains a PII-bearing field |
| F31 | No model or prompt version activates without a passing evaluation run |
| F32 | Every AI call site declares a budget scope |
| F33 | No student-facing route reaches a live inference call on the free tier |
| F34 | Golden-set verification catch rate on known-bad items ≥ 95% |

---
