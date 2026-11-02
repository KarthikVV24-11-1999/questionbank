# ADR-0056 — Identity keeps its own credentials and its own sessions

**Status** Accepted · M8 Track A, M8-01 to M8-05 · Replaces the path of [ADR-0014](ADR-0014-the-auth-stub-issues-a-principal-not-an-identity.md) that authenticated a human

## Context

Until now "the principal" was a token somebody signed by hand. ADR-0014 said so, said it would be replaced at the start of M8, and said how: a new adapter behind the `PrincipalResolver` port each
context already declares, with no call site changed. This is that replacement, and it needs a decision the stub never did: where credentials live and who holds them.

## Decision

**Credentials are ours.** A user's password is hashed with `scrypt` from `node:crypto` and stored by us; sessions are rows in Postgres; there is no identity vendor.

- **Password hash.** `scrypt` at N = 2^16, r = 8, p = 1, a 32-byte key and a 16-byte random salt per credential: about 64 MB a hash. Not 2^17, which at 128 MB a hash would make concurrent logins a memory problem before
  it made them a security win. Node's default `maxmem` is below what 2^16 needs, so it is raised in the call and N is not lowered to fit.
- **The parameters travel with the hash.** A credential row holds the algorithm, N, r, p and the key length it was made under, as columns. Verification reads them from the row; a login under older parameters than
  today's rewrites the credential. Raising N in two years is therefore a deploy, and a rehash on each person's next login, never a mass reset.
- **Sessions.** An opaque token, 32 random bytes, shown once and stored only as its SHA-256, so a leaked row is not a set of live logins. Every request looks its session up, so a revoked session, a disabled
  user and a session past its life or its idle window are refused at the very next request. This is the revocation ADR-0014 conceded it could not offer. A configured maximum of live sessions per user ends the oldest.
- **One-time tokens** (email verification, password recovery) are single-use, time-boxed, hashed at rest, and replaced by a second issue. Neither registration nor recovery says whether an address is registered.
- **The seam.** `PrincipalResolver.resolve(headers)` is synchronous and cannot ask a database. A middleware, before any controller, authenticates the request's token against the session table and records the answer
  against the request's own `headers` object; the resolver the contexts take hands back what was recorded for the headers it is given, and refuses headers no request went through. No controller changed (DEC-M8-1).

## Why not a vendor

Per-MAU pricing is a tax on growth, paid in proportion to success, and a student product's users are many and mostly light. And a managed provider that will not export password hashes makes the choice
irreversible at the cost of every student resetting a password: the price of leaving is set by the vendor. Considered and rejected:

- **Cognito.** Rejected on both counts. It does not export password hashes, so it cannot be left without a reset, and it is priced by monthly active users.
- **Auth0, Clerk.** Rejected on the same two counts. They price by monthly active users; export of hashes is something to ask for, at the vendor's discretion or plan, and not something we hold.

Doing it ourselves is more of our code to be right about. That cost is the reason the gates in this track exist and the reason the hash is the standard library's.

## What this forecloses

Nothing. The hashes are ours and the parameters are on the row; a move to a vendor that accepts scrypt hashes is an export, and a move to one that does not is a rehash on login, the same mechanism used to strengthen
the hash. Multi-factor sign-in, social login and a device list are additions to this context and none is made harder by it.

## ADR-0014: which path was taken

ADR-0014 offered two: delete `platform/auth/token.ts`, or keep it narrowly for service-to-service calls and no longer use it to authenticate a human request. **The second.** The composed application
resolves a human request through a session and through nothing else; the token module stays as the fixture and the future service-to-service credential, and `identity-rules.ts` fails the build if any shipped
route could resolve through it. A test that is not about login supplies the token resolver as its `principals`, which replaces the session resolver wholesale; nothing in production composition does.

## Consequences

**Makes easy:** login, logout and logout-everywhere; a password change that ends other sessions; recovery; a per-user device limit; moving the hashes elsewhere.

**Makes hard:** nothing a vendor made easy that we had a use for, but we now own breach response for credentials, and the routes that cost are limited and their hashing bounded by ADR-0057. The learner and studio apps still carry
their development-token paths (D69) and cannot sign in until a login screen is built on these routes.

**Not built here:** multi-factor, social sign-in, role assignment through a route (D96), a real mail provider (the port is the seam; the context README says what an adapter must satisfy).
