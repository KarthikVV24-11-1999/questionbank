# identity

Who a person is, how they prove it, and the sessions that prove it again on every request (ADR-0056). It is the one context that decides what `PrincipalResolver` answers; every other context takes
the port and imports nothing from here.

```
api/             IdentityController: register, login, logout, logout-all, session/rotate, password/change|recovery|reset, email/verify|verification
application/     the handlers, SessionAuthenticator, and the ports (stores, hasher, token factory, mail)
domain/          pure: email, password policy, hash parameters and needsRehash, session and one-time-token rules
infrastructure/  Postgres stores, the scrypt hasher, the session middleware and PostgresPrincipalResolver, the mail adapters
public/          composition.ts: the resolver and middleware for the root, and the routes
```

## How a request is authenticated

A middleware, before any controller, looks the bearer token up in `identity.session` and records the answer against the request's `headers`; `PostgresPrincipalResolver` hands that answer to whoever asks, and
refuses headers no request went through (DEC-M8-1). A revoked, expired, idle or disabled session is refused at the very next request. The answer is a `PrincipalRef` — kind, id, roles — and nothing else.

## What is stored

| | Stored as |
|---|---|
| Password | scrypt, with its salt and the parameters it was made under as columns; rehashed on the next login when they are not today's |
| Session token | SHA-256 of 32 random bytes; the token itself is shown once |
| Verification and recovery codes | SHA-256 of 32 random bytes; single use, time-boxed, replaced by a second issue |

A password never reaches a log, an error, an audit row or a response (`identity-rules.ts` holds the source to it).

## What a stranger can learn

Nothing about who is registered: registration and recovery answer the same for a known and an unknown address, a failed login is one status and one body, and each does the same work (DEC-M8-2). One limit: D95.

## The mail port, and what a real adapter has to satisfy

`MailPort.send(message)` is the seam; the provider is a later decision and this context does not make it. Development writes a file a message, a test keeps them in memory, and any other environment gets an adapter that
refuses to send. An adapter for a real provider must:

- deliver `message.body` to `message.to`, and report a failure to deliver as a rejected promise, not as success;
- treat `body` as a secret for `email_verification` and `password_recovery` (it holds a single-use code): never log it, never keep it past delivery, never put it in a URL it does not need to;
- make no retry that can send a second code for one request;
- not change the text of `already_registered`, which exists so a known address is told what a stranger was told nothing of.

## Not here

Rate limiting (D94), role assignment (D96), multi-factor and social sign-in, and a login screen in the apps (D69).
