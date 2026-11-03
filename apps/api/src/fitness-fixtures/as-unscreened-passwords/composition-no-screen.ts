/** Planted composition: a screen is built, shared, and every handler that sets a password is constructed from it. */
declare class PasswordScreen {
  constructor(deps: { source: object });
}
declare class RegisterHandler {
  constructor(deps: object);
}
declare class ChangeHandler {
  constructor(deps: object);
}
declare const users: object;
declare const hasher: object;
declare const credentials: object;

export function handlers() {
  const screen = { check: async () => ({ ok: true, value: '' }) };
  const common = { users, hasher, screen };
  return {
    register: new RegisterHandler({ ...common }),
    change: new ChangeHandler({ ...common, credentials }),
  };
}
