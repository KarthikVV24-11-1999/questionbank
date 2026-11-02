import { LoginHandler, LogoutHandler } from './handlers.js';

declare class ScryptPasswordHasher {}

/** Planted: the handlers are given the plain hasher, so nothing bounds their derives. */
export function build(deps: { hasher?: unknown }) {
  const common = { hasher: deps.hasher ?? new ScryptPasswordHasher() };
  return { login: new LoginHandler(), logout: new LogoutHandler(), common };
}
