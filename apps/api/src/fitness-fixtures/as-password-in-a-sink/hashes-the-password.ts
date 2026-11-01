/** Not a violation: a password handed to the hasher is what it is for, and an error that mentions the word in prose names no value. */
export async function handle(command: { password: string }, hasher: { hash(secret: string): Promise<unknown> }): Promise<unknown> {
  if (command.password.length < 12) throw new Error('that password is too short');
  return hasher.hash(command.password);
}
