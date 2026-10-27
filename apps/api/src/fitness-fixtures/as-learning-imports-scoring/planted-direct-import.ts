import { marksToDecimalString } from '../../contexts/scoring/public/index.js';

/**
 * Planted violation for `learning-rules.spec.ts` — a file of Learning's reading scoring directly. It is a barrel import, so F1
 * admits it; and it is a value import, so nothing but a rule about *which* contexts may meet can stop it. The spec treats this
 * file as if it lived in `contexts/learning/`.
 *
 * Never imported by production code.
 */
export const readsScoringDirectly = marksToDecimalString;
