import { createPrincipalResolver } from '../../platform/auth/principal-resolver.js';

/** Planted: shipped code building the token stub as a resolver, which is how a human request would be authenticated by a hand-signed token. */
export const resolver = createPrincipalResolver({ config: { signingKey: 'x'.repeat(32), issuer: 'questionbank' } });
