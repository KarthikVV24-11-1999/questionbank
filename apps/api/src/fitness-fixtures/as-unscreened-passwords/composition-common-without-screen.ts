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
  const screen = new PasswordScreen({ source: {} });
  const common = { users, hasher };
  return {
    register: new RegisterHandler({ ...common }),
    change: new ChangeHandler({ ...common, credentials }),
  };
}
