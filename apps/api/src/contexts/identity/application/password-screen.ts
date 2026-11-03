import { normalisePassword } from '../domain/password-normalisation.js';
import { checkPassword, type PasswordRefusal } from '../domain/password-policy.js';
import { err, ok, type Result } from '../domain/result.js';
import type { BreachCheckLog, BreachedPasswords } from './ports.js';

/**
 * Whether a password may be set at all (M8-11): the length rules, and then the check against passwords known to be bad. Every path that sets a password asks this and nothing
 * else (`fitness/password-rules.ts` holds it to that), so a source or a rule changes here once.
 *
 * **Why it exists.** Login is held to 30 guesses a quarter-hour at one address (DEC-M8-3 in docs/IMPLEMENTATION-DECISIONS.md), about 2,880 a day, which a password from a list of the
 * commonest falls inside. The limit and this check are the two halves of one defence (docs/SECURITY-ARCHITECTURE.md §3): the limit makes guessing slow, and this makes the first
 * guesses wrong.
 *
 * **When the source cannot answer, the password is accepted, and the lapse is recorded.** The alternative is to refuse, and then a third party's outage stops people registering and,
 * worse, stops them resetting a password they have lost. The check is a second line behind the rate limit, so a lapse costs some protection for the length of the outage and no
 * more, and it is not silent: every lapse writes one record (`BREACH_CHECK_UNAVAILABLE`, with whether the source said so or threw), which is what an operator alerts on. The bundled
 * list cannot be unavailable, so today this path is exercised by tests and by the day a networked source is wired in (D100 in docs/DEBT.md).
 *
 * **What a refusal says.** That the password is not acceptable, and nothing about anyone's address. The check reads only the password, before any address is looked up, so a
 * refusal is the same for a known and an unknown address and costs no derive (DEC-M8-2).
 *
 * It costs nothing to rate-limit: the bundled list is a set lookup. A networked source would be called inside the limits the routes already carry, and outside the bound on
 * hashing, because it derives nothing.
 */
export type ScreenRefusal = PasswordRefusal | 'PASSWORD_BREACHED';

export interface ScreenContext {
  /** What the password is being set for, for the record a lapse leaves. */
  readonly action: string;
  readonly correlationId: string;
}

export class PasswordScreen {
  constructor(private readonly deps: { readonly source: BreachedPasswords; readonly log?: BreachCheckLog }) {}

  async check(raw: unknown, context: ScreenContext): Promise<Result<string, ScreenRefusal>> {
    const checked = checkPassword(raw);
    if (!checked.ok) return err(checked.error);
    let verdict: Awaited<ReturnType<BreachedPasswords['lookup']>>;
    try {
      verdict = await this.deps.source.lookup(normalisePassword(checked.value));
    } catch {
      this.deps.log?.unavailable({ ...context, reason: 'source_error' });
      return ok(checked.value);
    }
    if (verdict === 'breached') return err('PASSWORD_BREACHED');
    if (verdict === 'unavailable') this.deps.log?.unavailable({ ...context, reason: 'source_unavailable' });
    return ok(checked.value);
  }
}

const SHORT_OR_LONG = 'That password is not acceptable: use at least 12 characters.';

/** What a caller is told. Every text is about the password and none about whose it is. */
export function describeRefusal(code: ScreenRefusal): string {
  return code === 'PASSWORD_BREACHED' ? 'That password is too common or has appeared in a data breach. Choose a different one.' : SHORT_OR_LONG;
}
