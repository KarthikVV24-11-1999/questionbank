/** Planted: the exempt method has gone, so the exemption names nothing. */
interface StoredCredential {
  readonly hash: string;
}
export interface UserStore {
  create(user: object, credential: StoredCredential): Promise<boolean>;
}
export interface CredentialStore {
  replaceAndRevoke(change: { readonly credential: StoredCredential }): Promise<void>;
}
