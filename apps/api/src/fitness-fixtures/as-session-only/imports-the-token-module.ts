import { verify } from '../../platform/auth/token.js';

/** Planted: shipped code reaching the token module itself, not the resolver built on it. */
export const check = verify;
