# ADR-0014 — The auth stub issues and verifies a principal, never an identity
Status: Accepted
Date: 2026-08-13

## Context

`PrincipalRef` is one of the shared kernel's three types
([domain-types/src/index.ts](../../packages/domain-types/src/index.ts)), and every context already
depends on it. `PrincipalResolver` is declared in three places — `content/api/http-runner.ts` and the
curriculum and scoring equivalents — and until M0 was implemented only in integration specs. M0 needs a
real implementation to serve one authenticated request end to end
(M0 DEC-M0-7).

Identity — users, credentials, sessions, role assignment — is M8's, per ROADMAP. M0 is three weeks and
does not own it. The question this ADR answers is what the narrowest thing is that makes "authenticated
request" true without M0 quietly becoming M8's context, built in the wrong place, three milestones early.

## Decision

`platform/auth/token.ts` issues and verifies a **bearer token carrying a principal**, and nothing else.

- **Format:** three base64url segments (`header.payload.signature`), HMAC-SHA256 over `header.payload`,
  verified with `node:crypto` alone — `jose` and `jsonwebtoken` are not in the offline store, and the
  format needs neither.
- **Claims, closed:** `sub` (`UserId`), `kind` (`PrincipalKind`), `roles` (`RoleSet`), `iat`, `exp`, `iss`,
  `jti`.
- **`verify` returns exactly a `PrincipalRef`** — `{ kind, id, roleContext }` — and nothing else. No other
  claim survives verification, asserted by a spec that checks the returned object's key set directly. A
  caller cannot start depending on a field the shared kernel does not name (§9 rule 5), because that field
  is never handed to the caller in the first place.
- **`kind: 'ai_agent'` verifies exactly like `kind: 'human'`** (D10 — machines act, and provenance
  records it). `INV-01` — that only a human signature can publish content — is enforced once, in
  `contexts/content`'s publication precondition. A spec asserts this module contains no mention of
  publication at all, so it cannot become a second, competing enforcement point.
- **No "alg" shortcut.** `verify` never reads an algorithm field from the token to decide how to check the
  signature; the header is fixed and ignored, and HMAC-SHA256 is always what gets recomputed. There is no
  branch to exploit, by construction rather than by a check.
- **Constant-time comparison, length-checked first.** `node:crypto.timingSafeEqual` throws on
  mismatched-length buffers; the length check happens before the call, so a malformed signature is refused
  rather than crashing the request.
- **The signing key has no default anywhere in source**, arrives only through the typed config module
  (M0-02), and is never logged, echoed, or included in an error message.

**What this is not**, stated so the next reader does not have to infer it from what is missing:

- **No user store.** There is no table, no record, and no lookup by `sub` — the token is the only place a
  principal's claims live.
- **No password**, and nothing resembling one. This module never sees a credential.
- **No refresh rotation.** A token expires; there is no second token that extends it.
- **No revocation list.** An issued token is valid until `exp`, full stop — there is no way to invalidate
  one early. This is a real gap and it is accepted for three weeks, not longer (see Consequences).
- **No role assignment.** `roles` arrives on the token exactly as issued; nothing here decides what a
  principal is entitled to, and nothing here writes a role anywhere.

All five are Identity's, in M8.

## Consequences

**Makes easy:** M0's walking skeleton (M0-14) authenticates a real request against a real signature check,
with the same `PrincipalRef` every context already types against — no context's authorization code changes
to accommodate the stub, because the stub's whole job is to produce the same shape a real Identity context
eventually will.

**Makes hard:** there is no way to issue a token for a real user today except by calling `issue` directly
with hand-supplied claims — which is exactly right for M0's scope (a walking skeleton, not a login flow)
and exactly wrong for anything resembling a product. Nobody should be tempted to wire a login form to this
module; it has no surface for one.

**Forecloses nothing.** `PrincipalResolver`'s interface (declared in each context's `api/` layer) does not
change when M8 replaces this — a `PostgresPrincipalResolver` backed by real sessions satisfies the same
port. The replacement is a new adapter, not a rewritten call site.

**Accepted for now, revisited at the trigger below:** no revocation means a compromised token is valid
until it expires. `authTokenTtlSeconds` (M0-02, default one hour) is the only mitigation available at this
tier, and it is a real limitation, not a theoretical one.

**Trigger for replacement:** the start of M8 (Identity & Auth). At that point `platform/auth/token.ts` is
either deleted in favour of a real session-backed `PrincipalResolver`, or — if a signed-token pattern is
still wanted for service-to-service calls — kept narrowly for that purpose alone and no longer used to
authenticate a human request.

## Alternatives

**A minimal user table with hashed passwords.** Rejected: that is Identity's context, not a stub, and
building even a minimal version of it inside M0 is the same mistake DEC-M0-6 named for the Learn shell —
three weeks of work built five milestones early, in the wrong bounded context, that M8 would have to
either inherit or throw away.

**`jose` or `jsonwebtoken`.** Rejected on the only fact that matters here: neither is in
`node_modules/.pnpm`, and M0 runs with no network. `node:crypto` needed no dependency to do the same job at
this scope.

**Session cookies instead of bearer tokens.** Rejected: a session needs somewhere to live — a store this
module deliberately does not have. A signed, stateless token is the only shape that fits "no user store."
