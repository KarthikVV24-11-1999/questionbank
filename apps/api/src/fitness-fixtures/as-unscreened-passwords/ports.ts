/** Planted ports for `password-rules.spec.ts` (M8-13): two stores that take a credential, one of which only rewrites a hash. */
interface StoredCredential {
  readonly hash: string;
}
export interface UserStore {
  create(user: object, credential: StoredCredential): Promise<boolean>;
  rehash(userId: string, credential: StoredCredential): Promise<void>;
  findById(userId: string): Promise<object | null>;
}
export interface CredentialStore {
  replaceAndRevoke(change: { readonly credential: StoredCredential }): Promise<void>;
}
export interface PasswordHasher {
  verify(password: string, stored: StoredCredential): Promise<boolean>;
}
