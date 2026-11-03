/** Planted: a store method added later that takes a credential. */
interface StoredCredential {
  readonly hash: string;
}
export interface UserStore {
  create(user: object, credential: StoredCredential): Promise<boolean>;
  rehash(userId: string, credential: StoredCredential): Promise<void>;
}
export interface CredentialStore {
  replaceAndRevoke(change: { readonly credential: StoredCredential }): Promise<void>;
  importCredential(userId: string, credential: StoredCredential): Promise<void>;
}
