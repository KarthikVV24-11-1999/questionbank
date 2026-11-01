import { createPrincipalResolver } from '../../platform/auth/principal-resolver.js';

/** Planted: a composition root that defaults to the token stub. */
export const principals = (overrides: { principals?: unknown }) => overrides.principals ?? createPrincipalResolver({ config: { signingKey: 'x'.repeat(32), issuer: 'questionbank' } });
