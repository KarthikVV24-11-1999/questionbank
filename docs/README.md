# Documentation index

One line per document: the question it answers, not what it contains.

## Product & requirements

- [PRD.md](PRD.md) — what is this product, for whom, and why does it win?
- [FRS.md](FRS.md) — what must the system do, stated as testable requirements?
- [NFR.md](NFR.md) — what must the system never fail at, under load or attack?
- [ROADMAP.md](ROADMAP.md) — in what order do the milestones ship, and what does each depend on?

## Architecture

- [ARCHITECTURE.md](ARCHITECTURE.md) — what are the system's pieces, and how do they compose?
- [DOMAIN-MODEL.md](DOMAIN-MODEL.md) — what are the aggregates, invariants and bounded contexts?
- [BACKEND-ARCHITECTURE.md](BACKEND-ARCHITECTURE.md) — how is the API structured internally?
- [FRONTEND-ARCHITECTURE.md](FRONTEND-ARCHITECTURE.md) — how are Studio and the learner client built?
- [DATA-ARCHITECTURE.md](DATA-ARCHITECTURE.md) — how is data modelled, migrated and kept consistent?
- [AI-ARCHITECTURE.md](AI-ARCHITECTURE.md) — how does AI generation and verification fit the pipeline?
- [ASSESSMENT-ENGINE.md](ASSESSMENT-ENGINE.md) — how are attempts scored and adapted?
- [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md) — what is the threat model, and what stops it?
- [TECH-STACK.md](TECH-STACK.md) — what technology was chosen, and why that one?
- [UX-ARCHITECTURE.md](UX-ARCHITECTURE.md) — what are the core user flows, screen by screen?
- [EVENT-TAXONOMY.md](EVENT-TAXONOMY.md) — what analytics events exist, and what do they mean?

## Engineering practice

- [ENGINEERING-HANDBOOK.md](ENGINEERING-HANDBOOK.md) — how is code here supposed to look and behave?

## Decisions

- [DECISIONS.md](DECISIONS.md) — what open product/business questions were closed, and how?
- [adr/](adr/) — for each divergence from an approved document: what changed, and why.

## Milestones

Breakdowns (ratified before code; task-by-task, with acceptance criteria):
- [tasks/M0-WALKING-SKELETON.md](tasks/M0-WALKING-SKELETON.md) · [tasks/M1-CURRICULUM-SPINE.md](tasks/M1-CURRICULUM-SPINE.md) · [tasks/M2-SCORING-ENGINE.md](tasks/M2-SCORING-ENGINE.md) · [tasks/M3-CONTENT-MODEL.md](tasks/M3-CONTENT-MODEL.md) · [tasks/M4-GOVERNANCE-REVIEW.md](tasks/M4-GOVERNANCE-REVIEW.md)

Close-outs (what actually shipped, verdict against the breakdown, honestly reported gaps):
- [tasks/M0-CLOSEOUT.md](tasks/M0-CLOSEOUT.md) · [tasks/M1-CLOSEOUT.md](tasks/M1-CLOSEOUT.md) · [tasks/M2-CLOSEOUT.md](tasks/M2-CLOSEOUT.md) · [tasks/M3-CLOSEOUT.md](tasks/M3-CLOSEOUT.md)

Traceability (every acceptance criterion mapped to the test that proves it):
- [tasks/M0-TRACEABILITY.md](tasks/M0-TRACEABILITY.md) · [tasks/M1-TRACEABILITY.md](tasks/M1-TRACEABILITY.md) · [tasks/M2-TRACEABILITY.md](tasks/M2-TRACEABILITY.md) · [tasks/M3-TRACEABILITY.md](tasks/M3-TRACEABILITY.md)
