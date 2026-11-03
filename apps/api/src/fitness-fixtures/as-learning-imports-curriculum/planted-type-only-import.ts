import type { CurriculumForLearning } from '../../contexts/curriculum/public/composition.js';

/**
 * Planted violation for `learning-rules.spec.ts` (M8-19) — a file of Learning's naming the seam type Curriculum offers it. Learning holds a port of its own and the composition root
 * fills it from the seam; reaching for the seam directly is the coupling the port exists to prevent, and a type-only import is the form a scan for `import {` walks past. The spec
 * treats this file as if it lived in `contexts/learning/`.
 *
 * Never imported by production code.
 */
export type BorrowedSeam = CurriculumForLearning;
