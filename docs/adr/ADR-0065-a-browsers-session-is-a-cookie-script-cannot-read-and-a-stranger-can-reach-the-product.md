# ADR-0065 — A browser's session is a cookie script cannot read, and a stranger can reach the product

**Status** Accepted · M8 Track J, M8-41 to M8-45 · Records DEC-M8-25, DEC-M8-26 and DEC-M8-27 (docs/IMPLEMENTATION-DECISIONS.md) · Closes D69 for the learner app and D119 to the extent it can be earned; registers D120 to D124 (docs/DEBT.md)

## Context

The learner app had no sign-in: it took a bearer token from `localStorage['qb-dev-token']`, which the API no longer accepts (ADR-0056), so no person could use it. A production process had no mail provider, so nobody could register against one (D119). Between them, a stranger could not get from an address to a first recommendation in a
browser, which is what the first acceptance criterion is about.

## Decision

**A process with the SES settings sends mail through Amazon SES, and a send that fails changes nothing a stranger is told** (DEC-M8-25, DEC-M8-27). `SesMail` sits behind `MailPort` beside the file, memory and refusing adapters; it is chosen when all four settings are present, in development or production but not under test (a production process does not start, D32, so tying it to production would have chosen it nowhere); without them development writes files and production refuses every send; with only some the process does not start and the missing ones are named. It is signed by hand over `fetch` (one call, so no SDK), against AWS's published test vector. Registration, recovery and the notice to a known address report a failed send and answer as before, because an error on one path and not the other would tell a stranger which addresses have accounts; the signed-in resend route says
so (503) and is the way to a message. There is no retry queue. The real send is not proved here: no run of this repository holds an AWS credential (Tier 3, `Fail — blocked`, D120).

**The session is an `HttpOnly`, `Secure`, `SameSite=Lax` cookie** (DEC-M8-26), set by login and rotation and cleared by logout. A second cookie, `qb_csrf`, is a hash of the session token and is readable by the app, which echoes it in `X-CSRF-Token`. A request that is authenticated by the cookie, and is not a read, is refused unless
its `Origin` (when it has one) is the learner app's own and it carries the echo. The routes that act as nobody (register, login, recovery, reset, verify) are held to the origin only, so a cookie gone stale cannot lock a person out of signing in. A request with an `Authorization` header is authenticated by it alone and needs neither
cookie nor echo, so clients that are not browsers are unchanged. The learner app sends `credentials: 'include'` and the echo through the typed client; nothing about a session is in `localStorage`.

**A stranger's way in is a set of screens that hold no state** (M8-43): sign in, create an account, check your mail with a resend, confirm an address from the link in a message (which continues to the questions about the exam, not an empty home), ask for a recovery message, and choose a new password. A link in a message carries its code
after `#`, which a browser sends to no server and no other site, and the app removes it from the address at once. The question "am I signed in" is asked of the server, and only its 401 sends a person to sign in, so a lost connection never turns a learner out of a paper.

## Why not the alternatives

**Keep the token in memory only** would have been the narrower step the brief allowed. It needs no CSRF defence, and it costs the learner a sign-in on every reload, including in the middle of a paper on a poor connection. It was kept as the fallback if a cookie could not be done well; the cookie could be.
**A signed double-submit token** (an HMAC under a server key) would add a key to manage. The echo here is a hash of the session token, which only someone who has the token can compute, and the origin check is a second line.
**A retry queue for mail** would hold a secret in storage until it is sent and retry a message the person has already asked for again (DEC-M8-25).

## What is not claimed

`SameSite=Lax` and the echo stop another site acting as the person; neither stops a script already running in the app's own page, which can send the header. The cookie keeps such a script from taking the session away. The login response still carries the session token in its body, for clients that are not browsers. Studio still
takes a development token from `localStorage` and cannot sign in (D121). A learner who signs in on a device beyond the limit is signed out of the oldest, and the server says nothing, so no screen can (D122). SES delivery is not proved (D120). The process that serves people is a `development` process until production can start (D124), and the Compose file publishes the database on every interface (D123).
