import { createMasteryEvidence } from '../../contexts/learning/public/composition.js';

/**
 * Planted violation for `learning-rules.spec.ts` — a file of content's calling Learning: a value import of a composition
 * seam, which M5-37 would admit from a root and which no context may take from another. The spec treats this file as if it
 * lived in `contexts/content/`.
 *
 * Never imported by production code.
 */
export const callsItsConsumer = createMasteryEvidence;
