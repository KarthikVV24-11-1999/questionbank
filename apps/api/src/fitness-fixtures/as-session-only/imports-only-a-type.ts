import type { PrincipalResolver } from '../../platform/auth/principal-resolver.js';
import { type PrincipalResolverHeaders } from '../../platform/auth/principal-resolver.js';

/** Not a violation: the port is a type, and a type is not a use of the stub. */
export const accepts = (resolver: PrincipalResolver, headers: PrincipalResolverHeaders) => resolver.resolve(headers);
