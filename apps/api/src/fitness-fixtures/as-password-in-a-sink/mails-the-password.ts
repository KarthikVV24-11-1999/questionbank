/** Planted: a password into a mail. */
export function handle(command: { password: string }, mail: { send(message: unknown): void }): void {
  mail.send({ body: command.password });
}
