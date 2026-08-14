# @questionbank/domain-types

The shared kernel: types every bounded context is permitted to depend on without going through another
context's `public/` barrel — `PrincipalRef` and the handful of other identity/reference shapes that are
genuinely cross-cutting. Deliberately small. A type belongs here only if putting it in one context's barrel
instead would force every other context to depend on that context just to name a principal.

## How to run it

This is a types-only library with no runtime behaviour of its own — nothing to start.

## How to test it

```bash
corepack pnpm typecheck
corepack pnpm test   # vitest
```

Tests here are narrow: construction and narrowing of the shared value types, and nothing else — business
logic does not belong in the shared kernel, and a test that looks like it's testing business logic here is a
sign the type doesn't belong in this package.
