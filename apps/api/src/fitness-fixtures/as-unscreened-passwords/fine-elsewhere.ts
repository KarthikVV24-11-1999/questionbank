/** A shipped file that is not a handler and does not write a credential: a `create` that is somebody else's, and a rehash. */
declare const posts: { create(draft: object): Promise<void> };
declare const users: { rehash(userId: string, credential: object): Promise<void> };

export async function elsewhere(): Promise<void> {
  await posts.create({});
  await users.rehash('u', {});
}
