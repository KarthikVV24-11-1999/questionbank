import { toAnswerKeyData } from './via-helper.js';

/** A packaging module that reaches key material two hops away, through an innocent-looking helper. */
export const packaged = (): string => toAnswerKeyData();
