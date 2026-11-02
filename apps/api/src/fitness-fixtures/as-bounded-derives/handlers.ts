declare const hasher: { hash(password: string): Promise<unknown>; verify(password: string, stored: unknown): Promise<boolean> };

/** Planted: a handler that derives, and one that does not. */
export class LoginHandler {
  readonly deps = { hasher };
  async handle(): Promise<boolean> {
    return this.deps.hasher.verify('x', null);
  }
}

export class LogoutHandler {
  async handle(): Promise<boolean> {
    return true;
  }
}
