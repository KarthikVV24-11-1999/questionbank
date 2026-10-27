import type { DifficultyBand } from '../../contexts/content/public/index.js';

/**
 * Planted violation for `learning-rules.spec.ts` — a file of Learning's naming a type of content's. A type-only import has no
 * runtime effect and is the one a scan for `import {` walks past; it couples the two contexts' source exactly as far as a value
 * does. The spec treats this file as if it lived in `contexts/learning/`.
 *
 * Never imported by production code.
 */
export type BorrowedBand = DifficultyBand;
