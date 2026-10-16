// Planted violation for composition-rules.spec.ts (M5-37): a composition-root-shaped
// file importing a context's public barrel. The older F1 rule admits this; the seam
// rule does not, because the root may import `public/composition.js` and nothing else.
export type { StartGenerationRun } from '../../contexts/generation/public/index.js';
