/**
 * Not production code. Proves review plumbing importing the role vocabulary,
 * `platform/auth/roles.ts`, is permitted (ADR-0026) — the one module outside
 * the context a content module may name.
 */
import { ROLES } from '../../../../platform/auth/roles.js';

export const usesTheVocabulary = ROLES.reviewer;
