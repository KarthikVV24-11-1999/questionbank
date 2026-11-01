/** Planted: a password into a log, an error, a response and an audit row. */
export function handle(command: { password: string; newPassword: string }, logger: { log(entry: unknown): void }, response: { json(body: unknown): void }, audit: { record(entry: unknown): void }): void {
  logger.log({ message: `login failed for ${command.password}` });
  throw new Error(`bad password ${command.newPassword}`);
  response.json({ echoed: command.password });
  audit.record({ detail: command.newPassword });
}
