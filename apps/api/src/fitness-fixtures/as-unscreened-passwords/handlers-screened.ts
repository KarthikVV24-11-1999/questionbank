/**
 * Planted for `password-rules.spec.ts` (M8-13). A stand-in for identity's handlers, ports and composition: the rule reads syntax, not types. Never imported by production code.
 */
interface StoredCredential {
  readonly hash: string;
}
interface Checked {
  readonly ok: boolean;
  readonly value: string;
}
declare function checkPassword(raw: unknown): Checked;
interface PasswordScreen {
  check(raw: unknown): Promise<Checked>;
}
interface PasswordHasher {
  hash(password: string): Promise<StoredCredential>;
}
interface UserStore {
  create(user: object, credential: StoredCredential): Promise<boolean>;
}
interface CredentialStore {
  replaceAndRevoke(change: { readonly credential: StoredCredential }): Promise<void>;
}

export class RegisterHandler {
  constructor(private readonly deps: { readonly users: UserStore; readonly credentials: CredentialStore; readonly hasher: PasswordHasher; readonly screen: PasswordScreen }) {}

  async handle(command: { readonly password: unknown }): Promise<boolean> {
    const strength = await this.deps.screen.check(command.password);
    if (!strength.ok) return false;
    return this.deps.users.create({}, await this.deps.hasher.hash(strength.value));
  }
}

export class ChangeHandler {
  constructor(private readonly deps: { readonly users: UserStore; readonly credentials: CredentialStore; readonly hasher: PasswordHasher; readonly screen: PasswordScreen }) {}

  async handle(command: { readonly password: unknown }): Promise<boolean> {
    const next = await this.deps.screen.check(command.password);
    if (!next.ok) return false;
    await this.deps.credentials.replaceAndRevoke({ credential: await this.deps.hasher.hash(next.value) });
    return true;
  }
}

/** Does not set a password: it rewrites a hash it has verified, which the rule exempts. */
export class RehashingHandler {
  constructor(private readonly deps: { readonly hasher: PasswordHasher; readonly rehasher: { rehash(userId: string, credential: StoredCredential): Promise<void> } }) {}

  async handle(): Promise<void> {
    await this.deps.rehasher.rehash('u', await this.deps.hasher.hash('same password'));
  }
}
