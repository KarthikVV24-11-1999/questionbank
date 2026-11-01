import { identityPrincipals } from '../../contexts/identity/public/composition.js';

/** Not a violation: the default is the identity context's resolver. */
export const principals = (overrides: { principals?: unknown }, pool: never, clock: never) => {
  const identity = identityPrincipals({ pool, clock });
  return overrides.principals ?? identity.resolver;
};
