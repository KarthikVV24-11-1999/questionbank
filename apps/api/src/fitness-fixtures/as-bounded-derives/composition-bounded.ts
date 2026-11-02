import { LoginHandler, LogoutHandler } from './handlers.js';

declare class BoundedPasswordHasher {
  constructor(inner: unknown, bound: unknown);
}
declare class ScryptPasswordHasher {}

/** Planted, and fine: the handlers are given a hasher that is the bounded one. */
export function build(deps: { hasher?: unknown }, bound: unknown) {
  const common = { hasher: new BoundedPasswordHasher(deps.hasher ?? new ScryptPasswordHasher(), bound) };
  return { login: new LoginHandler(), logout: new LogoutHandler(), common };
}
