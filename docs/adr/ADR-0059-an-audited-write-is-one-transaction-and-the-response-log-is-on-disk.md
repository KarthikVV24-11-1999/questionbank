# ADR-0059 — An audited write is one transaction, and the response log is on disk when it says it is

**Status** Accepted · M8 Track D, M8-14 to M8-17 · Closes D106 and D66 (docs/DEBT.md)

## Context

Two unrelated gaps, each found by reading what a sentence promised against what the code did. Identity committed a change and then wrote the audit row that records it through a second call, so a crash between the two left a privilege grant with
no record of who made it (found in Track C, written into D101, now D106). And the learner app wrote its response log to `localStorage`, which Chrome commits some seconds after a write and, after the first few commits, about once a minute; a
browser killed outright lost up to a minute of answers, and with the backend unreachable nothing anywhere had them (D66, measured in D93).

## Decision

**The store writes the audit row with the change** (DEC-M8-7 in docs/IMPLEMENTATION-DECISIONS.md). Eight identity writes were checked and all had the hole. Each audited store method takes the record, or a function from the person's id to it where that
id is only known inside the transaction, and writes it on the transaction's own connection after the change. The shape is M3-32's: the repository takes the events with the aggregate. Verifying an address also spent the code, marked the address and wrote the
row in three separate calls; it is one now. A spec runs every one of them with an audit write that fails (nothing of the change may remain) and with a recorder that looks from a second connection while the transaction is open (neither the change nor the
row may be visible yet), which catches a row written through a pool and a row written after the commit by a different failure each.

**The response log is in IndexedDB, committed with strict durability** (DEC-M8-8). A commit is one transaction over the facts of the attempt, one row per event and the active marker, and resolves when the transaction completes, which for strict durability is
after the data is on disk. A row per event, not one record rewritten each time, so the cost of a write does not grow with the attempt.

**The screen does not wait.** The answer is in the engine's state and shown at once. A writer keeps one commit in flight and groups everything that changed meanwhile into the next. **Nothing is sent until the commit that holds it has landed:** sent first,
a kill before the commit would leave the server with an event the device had forgotten, and the device would reuse its sequence number. The alternatives were to block the tap on the commit (tens of milliseconds a tap, and more on a busy phone) and to batch on a
timer (the same window as `localStorage`, smaller); neither beats a group commit that costs nothing visible.

**If a write fails after the screen accepted the answer,** the answer stays, the screen says in calm words that this device is not keeping the answers and to keep the page open, and events are sent as they are given. The server is then the only other
holder, and holding events back for a disk that is not answering would lose them. A submission waits up to five seconds for answers to reach the disk and then goes without waiting, so a disk that never answers cannot hold a paper in.

**What an earlier build left is moved, not lost.** Before the page renders, records in `localStorage` are copied into the store; each old key is removed only after the commit that holds the copy has resolved. Dying between leaves it in both, and the next run merges
them by event id. A record that does not parse is left untouched.

**The harness reads the new store.** `durable.ts` still establishes durability by starting a second Chrome on a copy of the profile's storage and reading the record, now from IndexedDB. The two-minute wait is gone with the thing it waited for; the
bound is thirty seconds. A kill on a healthy disk loses nothing, so the `kill-without-durability` sabotage has nothing to lose on its own: the pair of runs that shows the gate now plants a slow disk (writes held in memory for four seconds), under which a
kill without the gate loses events and one with it does not.

## Consequences

**Makes easy:** a new audited write is one store method that takes its record; a new durable record is another object store behind `RecordStore`.

**Makes hard:** the learner bundle is 16 kB heavier (3.1%), and the harness now has a planted slow disk to maintain.

**What is still lost,** and its size, is in D66's closing entry: an answer whose commit has not completed when the browser dies, about 15 ms after a tap on a healthy disk. The analytics buffer is still in `localStorage` (D107).
