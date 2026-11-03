# ADR-0058 — Refuse known-bad passwords, and make the first person who is not a learner

**Status** Accepted · M8 Track C, M8-11 to M8-13 · Closes D96 (docs/DEBT.md)

## Context

Track B held an address to 30 guesses a quarter-hour (DEC-M8-3, docs/IMPLEMENTATION-DECISIONS.md), about 2,880 a day, in preference to a lockout that grows and lets anyone who knows an address keep its owner out. The password policy asks for
twelve characters and nothing else, which is right by current guidance, whose other half is a check against passwords known to be bad. Each decision is correct and the pair leaves a hole: `password1234` is a valid password and falls inside a
day. docs/SECURITY-ARCHITECTURE.md §3 already said the credential-stuffing defence was rate limiting plus rejection of breached passwords; only the first existed.

Separately, everyone who registers is a `learner` and the first author, reviewer or administrator is made by a database update (D96).

## Decision

**Refuse at every path that sets a password.** Registration, change and reset all ask one object, `PasswordScreen`, which applies the length rules and then looks the password up. A reset is the path an attacker reaches with a stolen inbox, so it is
held to the same check as the first password. A fitness rule holds the handlers to it (M8-13).

**A bundled list now, the range service later, behind one port.** The Pwned Passwords range API is current and enormous, and its k-anonymity means the password never leaves. What it adds is a third party's latency and availability on the
registration and reset paths, which must not block. A list that ships with the code costs a set lookup, needs no network and has no outage to choose a behaviour for. What it gives up is coverage and freshness; the list is a few hundred
entries and says so, and D100 carries the range-service adapter. The port answers `breached`, `not_found` or `unavailable`, so a source that can fail and one that cannot have the same shape.

**When the source cannot answer, accept and record.** The alternative, refusing, lets a third party's outage stop sign-ups and password recovery. The check is a second line behind the rate limit, so a lapse costs protection for the length of the
outage and no more; every lapse writes one record with the code `BREACH_CHECK_UNAVAILABLE`, which is what an operator alerts on (DEC-M8-4).

**One normal form.** The hasher derives from the NFKC form of a password, and the lookup reads the same form from the same function. A check that compared another form would miss a match the hash would have made. Matching is of the whole
password and ignores case, since a guessing run mangles case first. Two shapes no list could hold are matched by rule: a short unit repeated end to end, and a run that steps one character up or down all the way.

**A refusal is not an oracle.** The check reads only the password and runs before any address or code is looked up, so the refusal is the same for a known and an unknown address, costs no derive, and spends no code (DEC-M8-2). The simulation
counts it the way Track B counted the limiter.

**Roles are given by an administrator, and in force at once.** `POST /v1/identity/roles/assign` and `/remove` are for `admin` alone, take the address and the role, change what the person holds in one transaction, and write an audit
row naming the person and the role. The roles a person can hold are the human ones from the vocabulary; `guest` and the two machine roles are refused. Nobody is left without a role, the last enabled administrator cannot be removed (two removals at
once cannot both succeed), and nobody changes their own roles. A session does not carry roles: the principal is built from the user row on every request, so a revoked administrator is refused at the next one, with no cache to invalidate and no
login forced on a student who was made an author (DEC-M8-5). The role-vocabulary rule now also judges a role handed to a person as a string.

**The first administrator.** A seeded migration, a one-shot command and a manual step were all defensible. A migration carries a name into every environment; SQL by hand is unaudited. The choice is a command, `bootstrap-admin`, that needs the
database, works while no enabled administrator exists, requires a verified address, and is audited as the system (DEC-M8-6). It is not a route.

**A gate on the password paths.** A fitness rule reads the credential-writing methods off the ports, finds the handlers that call them, and requires each to ask the screen first, return on a refusal, hash what the screen returned, and be
built in the composition from the dependencies that carry the screen. Nothing outside the handlers may write a credential. Its header says what it cannot see.

**What the sweep found.** Reading SECURITY-ARCHITECTURE and NFR against what now exists turned up claims the code does not meet: no second factor or step-up (D101), sessions that are not the short-lived, reuse-detecting design (D102), no
retention or erasure for identity's data (D103), a rate-limit section describing another algorithm and numbers (D104), and denials that leave no record and a support role that does not exist (D105). Each is registered with a trigger; none is fixed
here. The rule that no role can alter its own role set was a claim the new routes could have broken, and is kept. The hash is scrypt, and the line that said Argon2id now says so.

## Consequences

**Makes easy:** a new source is an adapter; a new path that sets a password is one the fitness rule makes ask the screen.

**Makes hard:** the list is short, so the defence is partial until D100 is done. A lapse of the check is silent to the person and loud to the operator, by design. There is now a way to make an administrator and no second factor to ask of one (D101).

**Not built here:** the range-service adapter; comparing a password with the person's address or the product's name (D100); a second factor or step-up (D101).
