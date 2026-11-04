import { SesMail, type MailPort } from './contexts/identity/public/composition.js';
import { loadConfigFromProcessEnv, type AppConfig, type ConfigResult } from './platform/config/config.js';

/**
 * Whether SES takes a message from this deployment's own settings (M8-41): `pnpm --filter @questionbank/api mail-smoke <address>`, run with the application's environment.
 *
 * It is the one thing no run in this repository can do, because it needs an AWS credential and a sender SES has verified (ADR-0013, Tier 3), so it is a command for the owner to
 * run on the host. It sends one message to the address given and says what happened. SES in its sandbox delivers only to verified addresses, so the recipient has to be one.
 *
 * Exit status: 0 when SES took the message (which is not delivery: check the inbox), 1 when it refused or could not be reached (the reason is printed, and it holds no secret),
 * 2 when it could not run: no address, or the mail settings absent or not whole.
 */
export async function run(
  argv: readonly string[],
  load: () => ConfigResult<Pick<AppConfig, 'mailSes'>>,
  write: (line: string) => void,
  make: (settings: NonNullable<AppConfig['mailSes']>) => MailPort = (settings) => new SesMail(settings, { fetch, now: () => new Date() }),
): Promise<number> {
  const to = argv[0];
  if (to === undefined || argv.length !== 1) {
    write('usage: mail-smoke <address>');
    return 2;
  }
  const config = load();
  if (!config.ok) {
    write(config.error.message);
    return 2;
  }
  if (config.value.mailSes === undefined) {
    write('MAIL_SES_REGION, MAIL_SENDER, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set, so there is nothing to try');
    return 2;
  }
  try {
    await make(config.value.mailSes).send({ to, purpose: 'email_verification', subject: 'A test message from the question bank', body: 'This message was sent to check that mail works. There is nothing to do.' });
    write(`SES took the message for ${to}; whether it arrived is for the inbox to say`);
    return 0;
  } catch (error) {
    write(`SES did not take the message: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.env['VITEST'] === undefined) {
  void run(process.argv.slice(2), loadConfigFromProcessEnv, (line) => process.stdout.write(`${line}\n`)).then((code) => process.exit(code));
}
