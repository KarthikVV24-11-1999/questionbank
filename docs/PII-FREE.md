# The PII-free argument

**No name, email address or phone number is in any field of any analytics event, ever — EVENT-TAXONOMY §1 rule 1 (PRI-08, F10), blocking.** This is the one place that
says, surface by surface, what keeps it so and what each part rests on. It is built as [KEY-FREE.md](KEY-FREE.md) is: a table a test reads
(`apps/api/src/fitness/pii-free-rules.spec.ts`) where every row names a test that shows personal data absent and a test that shows the scan able to find some, and the
check fails if a named test is renamed away, skipped, or if a surface is missing from the list.

The argument has three layers.

1. **Nothing is built from a person's record.** An event carries a pseudonymous identifier, identifiers of the things it is about, enumerated words, flags and counts. The
   actor and session fields only admit an identifier (no whitespace, no `@`), and no field of the catalog is named for a person's details.
2. **The edge scans what it is given.** Every event is scanned whole before it is admitted: field names, email addresses, phone numbers and free text (a string with a
   space in it, which no catalog value is) at any depth. An event that fails is quarantined with the path and the kind of what was found, and never with the value.
3. **What is kept is scanned too.** What reaches the sink and what the quarantine holds are serialised and scanned, and the scan is shown to find a planted name, email
   and phone number where they are held, so an empty result is an empty result and not a scan that cannot see.

| Surface | Personal data is absent — shown by | The scan can see some — shown by |
|---|---|---|
| `catalog-fields` — no field the catalog names is a person's detail | `apps/api/src/platform/analytics/pii-free.spec.ts` :: names no field of the catalog a personal detail | `apps/api/src/platform/analytics/pii-free.spec.ts` :: finds a personal field planted in a catalog row |
| `envelope` — an envelope for every catalog name | `apps/api/src/platform/analytics/pii-free.spec.ts` :: finds none in an envelope built for every catalog name | `apps/api/src/platform/analytics/pii-free.spec.ts` :: finds a planted name, email and phone in an envelope field, a payload field and a context field |
| `server-events` — the events the server emits (`mastery.gain_verified`) | `apps/api/src/platform/composition/learning-consumer.spec.ts` :: carries no personal data in the event it emits | `apps/api/src/platform/composition/learning-consumer.spec.ts` :: refuses the same event with an email for its actor, so the scan sees it |
| `learner-events` — the events the learner app's screens emit | `apps/learn/src/ui/ReportScreen.spec.tsx` :: emits only events whose envelope the contract accepts, with no personal data in any of them | `apps/learn/src/analytics/emitter.spec.ts` :: does not scrub what a screen gives it, so the scan that checks what the screens emit can see a planted name |
| `edge-accepted` — what the edge writes to the sink | `apps/api/src/platform/analytics/pii-free.spec.ts` :: writes nothing personal to the sink for the events it accepts | `apps/api/src/platform/analytics/pii-free.spec.ts` :: refuses an event carrying a planted name, email or phone in any field |
| `quarantine` — what the edge keeps of what it refused | `apps/api/src/platform/analytics/pii-free.spec.ts` :: keeps the path and the kind of what it refused and never the value | `apps/api/src/platform/analytics/pii-free.spec.ts` :: has the planted values in what was sent, so the absence above is not a scan of nothing |

## What the argument does not claim

- **A single word under a harmless key passes.** `"label": "Asha"` is not a field named for a person, not an address, not a number and not free text. The scan reads
  shape, and a name that is one word looks like an enumerated value. What stands behind it is layer 1: no emitter builds an event from a person's record, and the
  pseudonymous mapping is Identity's (M8).
- **A key is matched exactly.** `name`, `email`, `phone`, `address` and the other names in `analytics-pii.ts`, without regard to case or separators; `candidate_name` is
  not on the list, and a value under it with a space in it is caught by shape.
- **Ten-digit numbers written as numbers** between 6,000,000,000 and 9,999,999,999 are read as a mobile number, so a duration that long in milliseconds would be
  refused; none of the catalog's payloads reaches it.
- **The sink's contents are not the whole of the platform.** This is about analytics events. Logs have their own allowlist serializer, and the outbox its own payload
  discipline.
