# ADR-0013 — Unrunnable infrastructure is proven by parsing
Status: Accepted
Date: 2026-08-14

## Context

Track D (M0-20 through M0-23) authors Compose, CI and Terraform on a machine with no Docker, no CI
provider, and no Terraform provider plugins available offline. M0 DEC-M0-1
already named the three-tier split this milestone works under; this ADR is that decision's permanent
home, so a future milestone cites it rather than re-deriving the same argument the next time it authors
something it cannot run.

## Decision

Three tiers, applied uniformly to every artifact in this repository that describes infrastructure or a
process this machine cannot execute:

| Tier | Definition | Done means | May claim |
|---|---|---|---|
| **1 · Executable** | Runs in an environment whose result is observable and reproducible — this machine against Node 22 and the local Postgres, or the CI runner ([ADR-0023](ADR-0023-the-ci-workflow-is-executed-and-leaves-tier-2.md) widened this from "here" once a runner existed) | Merged with tests green | Everything it proves |
| **2 · Authored & asserted** | A committed artifact whose *semantics* a test can parse and check | The artifact exists, parses, and every assertion over it is shown to fail on a planted mutation of the artifact itself | Only what the parse proves. **Never a runtime property** |
| **3 · Unverifiable here** | Needs a machine, an account or a network this environment does not have | Recorded `Fail — blocked`, naming the missing resource and the exact command that will run when it exists | Nothing |

Three rules make this binding:

1. **A Tier-2 artifact never claims a Tier-1 property.** `docker-compose.yml` may be asserted to declare a
   health check on every service; it may not be described as booting, and no boot time appears anywhere in
   this repository until one has actually been measured.
2. **Every Tier-2 task names its Tier-3 successor check**, written into the spec itself — `docker compose …
   up --wait`, the CI run, `terraform init && terraform validate && terraform plan` — so the day the
   resource exists, upgrading the claim is a checklist, not an archaeology exercise.
3. **A Tier-3 item is carried as an explicitly blocked line**, never omitted. An omitted criterion is one
   nobody notices is missing.

## Consequences

**Makes easy:** Compose (M0-20), CI (M0-21) and Terraform (M0-22) can all be authored and reviewed now,
on this machine, without the review conflating "this file is well-formed" with "this file works" — the two
questions stay separate because the tier answering each is named at the top of every spec that checks one.

**Makes hard:** nothing new. Tier 2 was already this milestone's practice from M0-09 onward (`checkNoTsxFiles`,
`checkBoundaries`); this ADR names the pattern rather than introducing it.

**Forecloses nothing.** Every Tier-2 spec's own header states the exact command that upgrades it, so no
future session has to guess what "done" would have meant with a machine present.

## Alternatives

**Skip authoring infrastructure until a machine with Docker/CI/Terraform exists.** Rejected: DEC-M0-11
already made this argument for Terraform specifically — authoring now is what makes the first real staging
deploy a day rather than a week, and the same reasoning holds for Compose and CI.

**Claim these artifacts "work" on the strength of review alone, without a parse-level check.** Rejected:
that is exactly the vacuous-green failure mode M0's own standing instruction (DEC-M0-1) exists to prevent —
a reviewer's eyes are not a test that can fail on a planted mutation.
