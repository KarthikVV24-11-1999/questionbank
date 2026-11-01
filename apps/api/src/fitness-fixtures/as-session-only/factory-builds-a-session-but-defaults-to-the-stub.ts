import { createPrincipalResolver } from '../../platform/auth/principal-resolver.js';

declare function identityPrincipals(options: unknown): { resolver: unknown };

/** Planted: a root that builds the session resolver and then does not use it as the default. */
const identity = identityPrincipals({});
export const unused = identity;
export const principals = (overrides: { principals?: unknown }) => overrides.principals ?? createPrincipalResolver({ config: { signingKey: 'x'.repeat(32), issuer: 'questionbank' } });
