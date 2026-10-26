# ADR-0041 — The server says when the time is up, and a reopened question is visited again

**Status** Accepted · M6 Track H, M6-54 and M6-55 · Amends the session behaviour [ADR-0039](ADR-0039-the-learner-shell-is-a-view-of-the-engine-and-verifies-what-it-shows.md) described

## Context

Two defects, both found by building the adversarial runs and both in code ADR-0039 described as finished.

**The device's own clock could end an attempt the server still had time on.** ADR-0039 has the shell derive the time left from the engine's
monotonic timer over the server's deadline, and submit as `expiry` at zero. A monotonic reading that jumps forward (a device that slept, a clock
that is wrong) takes the timer to zero early. The shell then submitted as `expiry`; the server refuses an expiry before its own deadline; the session
sat in `submitting`, accepting no more responses — the learner locked out of an attempt that had time left, until the server's deadline arrived.
The criterion is explicit that a clock jumped forward does not end the attempt early and that the server's deadline decides.

**A kill could be credited as time on item.** A question open when the app dies stays open in the log. After a reopen the monotonic clock has a new
origin, so the next `leave` is measured against a `visit` from another clock: the interval is meaningless, and when the new reading is ahead of the old
one it counts up to the interval cap. A learner killed ten times on a question could be credited with ten caps of time not spent on it, which is what the
cap exists to prevent, one interval at a time.

## Decision

**The timer reaching zero is a question put to the server.** When the local timer says time is up, `pump` asks the server for the attempt. If it can be
reached and says the attempt is in progress with time remaining (its `deadline` minus its own `serverNow`), the timer is **re-anchored** to that and the
learner carries on. If the server says the time is up, or is already submitted, the session submits as `expiry`. If the server **cannot be reached**,
the local timer stands and the submission is made and retried as before: offline expiry must not become a loophole, and the stricter view governs.
The server's deadline is therefore the only thing that ends an attempt, and the device's clock the thing that asks.

**A question open at a restart is visited again on resume.** `AttemptSession.resume` records a `visit` for the slot left open, in the new clock's
terms. The engine already defines what that means — a second visit with no leave between means the first was never closed, its time is unknown and counts
as nothing — so the time the app was not running is never credited, whatever the cap. The projection after a resume equals the one before it.

## Consequences

**Makes easy:** a forward jump of the device's clock costs a round trip and nothing else; a kill costs no time on item.

**Makes hard:** an expiry at the deadline now waits for the server's answer when it is reachable, which adds one request to the moment the time runs out.
A device whose clock runs slow is brought back to the server's at the deadline and not before: it shows more time than it has until then. That is the
timer the engine was built to be (a stand-in the server re-validates), not a new fault.

**Does not change** the server: its rule that an expiry before the deadline is refused, and its recording of late events without scoring them, are what
make the device's early or late reading harmless.

## Alternatives

**Trust the device's timer and let the server refuse.** That was the behaviour, and it locked the learner out.

**Re-read the server's time on a schedule.** Rejected as more traffic for no more correctness: the only moment the local reading can do harm is when it
says the time is up.

**Close the open visit on resume with a `leave`.** Rejected: a `leave` would credit an interval measured across two clocks; the engine's own rule for
an unclosed visit is the right one.
