/**
 * A planted F2 violation: a module treated as content's `domain/` that reaches
 * into another context. `domain/` imports nothing (§9 rule 2), and the spec
 * points the domain pattern at this directory to prove the rule fires rather
 * than only that the shipped tree happens to be clean.
 */
import type { AnswerKeyData } from '../../contexts/scoring/public/index.js';

export type SmuggledThroughABarrel = AnswerKeyData;
