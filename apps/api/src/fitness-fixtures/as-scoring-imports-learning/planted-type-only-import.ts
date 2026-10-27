import type { MasteryEvidence } from '../../contexts/learning/public/index.js';

/**
 * Planted violation for `learning-rules.spec.ts` — a file of scoring's naming a type of Learning's: the owning context learning
 * who consumes it. A type-only import, which a scan for `import {` walks past. The spec treats this file as if it lived in
 * `contexts/scoring/`.
 *
 * Never imported by production code.
 */
export type KnowsItsConsumer = MasteryEvidence;
