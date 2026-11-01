import { createPrincipalResolver } from '../platform/auth/principal-resolver.js';

/**
 * The signed-token resolver, handed to a composed application as its `principals` (ADR-0014, ADR-0056).
 *
 * The application authenticates a person by a session. A test that is about something other than login cannot have a person log in first, so it supplies this: the same
 * port, answered from a token the test signed itself. Passing it replaces the session resolver and installs no session middleware, so a test that does is not testing identity,
 * and `identity-rules.ts` fails the build if anything but a test, a fitness function or this directory imports the module that makes it.
 */
export const tokenPrincipals = (config: { readonly authSigningKey: string; readonly authIssuer: string }) =>
  createPrincipalResolver({ config: { signingKey: config.authSigningKey, issuer: config.authIssuer } });
