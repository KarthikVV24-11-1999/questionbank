import type { IdentityApi } from '../api/identity-api.js';

/** The server's sign-in as a screen sees it: it keeps what it was asked and can be made to refuse any call, once. */
export class FakeIdentityApi implements IdentityApi {
  readonly calls: string[] = [];
  /** `true` while a session is in force; a login makes one and a logout ends it. */
  session = false;
  /** The next call to this method fails with this. */
  readonly refuse: Partial<Record<keyof IdentityApi, Error>> = {};
  /** The next `signedIn` fails with this, as a lost connection does. */
  private record(name: keyof IdentityApi, ...args: string[]): void {
    this.calls.push([name, ...args].join(' '));
    const refusal = this.refuse[name];
    if (refusal !== undefined) {
      delete this.refuse[name];
      throw refusal;
    }
  }

  async signedIn(): Promise<boolean> {
    this.record('signedIn');
    return this.session;
  }
  async register(email: string, password: string): Promise<void> {
    this.record('register', email, password);
  }
  async login(email: string, password: string): Promise<void> {
    this.record('login', email, password);
    this.session = true;
  }
  async logout(): Promise<void> {
    this.record('logout');
    this.session = false;
  }
  async resendVerification(): Promise<void> {
    this.record('resendVerification');
  }
  async verify(code: string): Promise<void> {
    this.record('verify', code);
  }
  async requestRecovery(email: string): Promise<void> {
    this.record('requestRecovery', email);
  }
  async reset(code: string, newPassword: string): Promise<void> {
    this.record('reset', code, newPassword);
  }
}
