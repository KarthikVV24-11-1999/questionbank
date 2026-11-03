import { createMasteryEvidence } from '../../contexts/learning/public/composition.js';

/**
 * Planted violation for `learning-rules.spec.ts` (M8-19) — a file of Curriculum's reaching for Learning, which would make the owning context know who consumes it. The spec treats
 * this file as if it lived in `contexts/curriculum/`.
 *
 * Never imported by production code.
 */
export const borrowed = createMasteryEvidence;
