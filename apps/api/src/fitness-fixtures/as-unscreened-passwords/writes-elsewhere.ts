/** Planted: a shipped file that is not a handler and writes credentials. */
interface StoredCredential {
  readonly hash: string;
}
declare const users: { create(user: object, credential: StoredCredential): Promise<boolean> };
declare const credentials: { replaceAndRevoke(change: { credential: StoredCredential }): Promise<void> };
declare const credential: StoredCredential;

export async function seed(): Promise<void> {
  await users.create({}, credential);
  await credentials.replaceAndRevoke({ credential });
}
