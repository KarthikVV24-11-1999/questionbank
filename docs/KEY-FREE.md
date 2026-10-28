# The key-free argument

**No answer key and no marking material reaches a learner before they submit, and no solution body reaches one before the effort gate has opened it for that question — an attempt or an explicit skip on it (FRS 277), and for a mock also the submission — F6 and F35, blocking.** This is the one
place that says, surface by surface, what keeps it so and what each part rests on. It is a table a test reads
(`apps/api/src/fitness/key-free-rules.spec.ts`): every row names a test that shows the key absent and a test that shows the scan able to
find a key, and the check fails if a named test is renamed away, if a file is gone, or if a surface is missing from the list.

The argument has three layers, and a surface is only covered when all three it needs are there.

1. **Where the key is made and held is walled off.** The key lives in content's authoring surface (ADR-0009). Delivery code never reaches
   a module that makes or carries one (a static rule over the import graph, in both directions).
2. **What is built for a learner is built field by field.** A response is assembled from named fields and not from an object that might
   carry a key, so a key cannot appear by being forgotten.
3. **What leaves, is scanned.** Every payload a learner can receive is serialised and scanned for key fields and for the text a solution
   carries — and the scan is shown to find them where they are held, so an empty result is an empty result and not a scan that cannot see.

| Surface | The key is absent — shown by | The scan can see a key — shown by |
|---|---|---|
| `code-boundary` — delivery code and authoring code, both directions (F6/F35, ADR-0009) | `apps/api/src/fitness/content-rules.spec.ts` :: holds on the real tree, in both directions | `apps/api/src/fitness/content-rules.spec.ts` :: fires on a planted key-bearing delivery DTO |
| `package-code` — the form package's code reaches no key module (M6-25) | `apps/api/src/fitness/content-rules.spec.ts` :: holds for the real packaging modules | `apps/api/src/fitness/content-rules.spec.ts` :: fires on a packaging module that reaches key material two hops away |
| `catalogue-responses` — content's delivery responses, over live output | `apps/api/src/contexts/content/api/content.controller.integration.spec.ts` :: a delivery response carries no key material, over live output | `apps/api/src/contexts/content/api/content.controller.integration.spec.ts` :: is not vacuous — the same scan finds the key on an authoring response |
| `contract` — the assessment document names no key field | `apps/api/src/contracts/assessment-contract.spec.ts` :: declares no schema field that names key material | `apps/api/src/contracts/assessment-contract.spec.ts` :: finds a key field planted in a schema, however deep |
| `form-package` — the signed bytes a device downloads (M6-25) | `apps/api/src/platform/composition/assessment-http.integration.spec.ts` :: carries no answer key and no solution — and the same scan finds the key in those items | `apps/api/src/platform/composition/assessment-http.integration.spec.ts` :: the key-free scan is not vacuous |
| `form-routes` — every response of the form routes | `apps/api/src/platform/composition/assessment-http.integration.spec.ts` :: walks a form from draft to embargoed, and no response carries key material | `apps/api/src/platform/composition/assessment-http.integration.spec.ts` :: the key-free scan is not vacuous |
| `attempt-responses` — create, start, read, events, submission | `apps/api/src/contexts/assessment/api/attempt-responses.spec.ts` :: serves no key material on any attempt response | `apps/api/src/contexts/assessment/api/attempt-responses.spec.ts` :: and that scan is not vacuous: it finds each key field in a response that carries one |
| `practice-feedback` — what a learner is told of an answer while a practice run is open (M7-29) | `apps/api/src/contexts/assessment/application/practice-feedback.spec.ts` :: serves a verdict and no key material on any feedback a practice run gives | `apps/api/src/contexts/assessment/application/practice-feedback.spec.ts` :: and that scan is not vacuous: it finds each key field in feedback that carries one |
| `solution-delivery` — the one surface that carries a solution, and only behind the effort gate (M7-37). **Its two columns are not the others'**: the first shows the solution *absent* while the gate is shut, on every slot and every attempt; the second shows it *present* once the gate is open, and so that the scan can find it | `apps/api/src/contexts/assessment/api/slot-solution.spec.ts` :: serves no solution text while the gate is shut, on any slot of any attempt | `apps/api/src/contexts/assessment/api/slot-solution.spec.ts` :: serves the solution once the gate is open, and the same scan finds its text there |
| `result` — what a student reads of their score (M6-41) | `apps/api/src/platform/composition/assessment-scoring.integration.spec.ts` :: serialises with no key, no correct option and no solution | `apps/api/src/platform/composition/assessment-scoring.integration.spec.ts` :: and the same scan finds them where they are held |
| `relay-payloads` — what the outbox relay emits (D17) | `apps/api/src/platform/composition/assessment-scoring.integration.spec.ts` :: delivers AttemptSubmitted and AttemptScored to a consumer that scans every envelope | `apps/api/src/platform/composition/assessment-scoring.integration.spec.ts` :: fires on an envelope that carries a stem, a key, a solution or an answer |
| `learner-screens` — every screen, from a package that leaks | `apps/learn/src/ui/LearnApp.spec.tsx` :: shows no key even from a package that carries one | `apps/learn/src/ui/LearnApp.spec.tsx` :: the key is in the data the shell was handed |
| `learner-device` — the screens, the storage and the cache, in a real browser | `tools/adversarial/src/key-free.spec.ts` :: shows none of it on any screen, stores none of it on the device | `tools/adversarial/src/key-free.spec.ts` :: the scan finds it in what the server sent |

## What each layer does not claim

- **A solution behind the gate is a solution a learner can read.** `solution-delivery` is the first row that asserts presence. What it holds is that the gate is the database's (`assessment.solution_release`, a view over the stored events, read per slot) and that nothing reaches a solution without a `ReleasedSlot` only that view's repository makes; it does not hold that a learner who skips every question to read the solutions has made an effort worth the name. The gate is a floor on effort, not a measure of it.

- **A package that leaks is signed and cached like any other.** The learner app draws none of it and stores none of it, but the service
  worker keeps the package's bytes as they came: if the server were to send a key, the bytes on the device would hold it. The server is
  where the guarantee is made (layers 1 and 2, and the rows from `form-package` down); the rows below `learner-screens` are the learner
  app's own conduct, shown against a server made to misbehave.
- **The key is not secret from an operator.** Authoring and scoring read it, by design and by role; this document is about learners.
- **The scans are over what the tests send.** A field name that is not on the lists (the lists are in the named specs) would not be
  found by them; the static rule and the field-by-field construction are what stand behind that.
