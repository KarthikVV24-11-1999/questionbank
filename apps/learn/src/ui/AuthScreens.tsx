import { ApiProblemError } from '@questionbank/contracts/client';
import type { FormEvent, JSX } from 'react';
import type { IdentityApi } from '../api/identity-api.js';
import { TOKENS } from '../tokens.js';
import { authHref } from './auth-links.js';
import { screenHref } from './screen-context.js';
import { useAction, useRemote, useSubmit } from './use-remote.js';

/**
 * The screens that let a stranger in (M8-43): sign in, create an account, check your mail, confirm an address from the link in it, ask for a recovery message, choose a new password.
 *
 * None of them holds state of its own. A form is read when it is sent, the screen is chosen by the address (`auth-links.ts`), and what happened is told by reopening the address with a flag.
 * Every message says what to do next in the words a student uses; nothing here names a token, a session or an identifier.
 *
 * What the screens do not say: whether an address has an account. Creating one and asking for a recovery message answer the same for an address that is known and one that is not, as the
 * server does, so a screen that said more would undo it.
 */
const page = { padding: TOKENS.spaceMedium, maxWidth: '28rem' } as const;
const field = { display: 'block', marginBottom: TOKENS.spaceMedium } as const;

interface Entry {
  readonly form: FormData;
}
const text = (form: FormData, name: string): string => String(form.get(name) ?? '');

function Problem({ failure }: { readonly failure: string | null }): JSX.Element | null {
  return failure === null ? null : <p role="alert">{failure}</p>;
}

function Email({ autoComplete }: { readonly autoComplete: 'username' | 'email' }): JSX.Element {
  return (
    <label style={field}>
      Email address
      <input name="email" type="email" autoComplete={autoComplete} required style={{ display: 'block' }} />
    </label>
  );
}

function Password({ label, autoComplete, hint }: { readonly label: string; readonly autoComplete: 'current-password' | 'new-password'; readonly hint?: string }): JSX.Element {
  return (
    <div style={field}>
      <label>
        {label}
        <input name="password" type="password" autoComplete={autoComplete} required minLength={autoComplete === 'new-password' ? 12 : undefined} aria-describedby={hint === undefined ? undefined : 'password-hint'} style={{ display: 'block' }} />
      </label>
      {hint === undefined ? null : (
        <small id="password-hint" style={{ color: TOKENS.textMuted }}>
          {hint}
        </small>
      )}
    </div>
  );
}

const sent = (go: (entry: Entry) => void) => (event: FormEvent<HTMLFormElement>): void => {
  event.preventDefault();
  go({ form: new FormData(event.currentTarget) });
};

export function SignInScreen({ identity, returnTo, changed, onOpen }: { readonly identity: IdentityApi; readonly returnTo: string; readonly changed: boolean; readonly onOpen: (href: string) => void }): JSX.Element {
  const signIn = useSubmit(({ form }: Entry) => identity.login(text(form, 'email'), text(form, 'password')), () => onOpen(returnTo));
  return (
    <main aria-label="Sign in" style={page}>
      <h1>Sign in</h1>
      {changed ? <p role="status">Your password is changed. Sign in with the new one.</p> : null}
      <form aria-label="Sign in" onSubmit={sent(signIn.go)}>
        <Email autoComplete="username" />
        <Password label="Password" autoComplete="current-password" />
        <Problem failure={signIn.failure} />
        <button type="submit" disabled={signIn.busy}>
          Sign in
        </button>
      </form>
      <p>
        <a href={authHref('recover')}>Forgotten your password?</a>
      </p>
      <p>
        New here? <a href={authHref('register')}>Create an account</a>
      </p>
    </main>
  );
}

export function RegisterScreen({ identity, onOpen }: { readonly identity: IdentityApi; readonly onOpen: (href: string) => void }): JSX.Element {
  const create = useSubmit(
    async ({ form }: Entry) => {
      const email = text(form, 'email');
      const password = text(form, 'password');
      await identity.register(email, password);
      // signed in with what was just chosen, so the next screen can ask for the message again; an address that already had an account is told the same and simply is not signed in
      await identity.login(email, password).catch(() => undefined);
    },
    () => onOpen(authHref('sent')),
  );
  return (
    <main aria-label="Create an account" style={page}>
      <h1>Create an account</h1>
      <form aria-label="Create an account" onSubmit={sent(create.go)}>
        <Email autoComplete="email" />
        <Password label="Choose a password" autoComplete="new-password" hint="At least 12 characters. Three or four ordinary words in a row are easier to remember than a short mix." />
        <Problem failure={create.failure} />
        <button type="submit" disabled={create.busy}>
          Create account
        </button>
      </form>
      <p>
        Already have an account? <a href={authHref('signin')}>Sign in</a>
      </p>
    </main>
  );
}

export function CheckMailScreen({ identity, again, onOpen }: { readonly identity: IdentityApi; readonly again: boolean; readonly onOpen: (href: string) => void }): JSX.Element {
  const resend = useAction(
    () =>
      identity.resendVerification().catch((error: unknown) => {
        if (error instanceof ApiProblemError && error.problem.status === 401) throw new Error('Sign in, then ask for it again.');
        throw error;
      }),
    () => onOpen(authHref('sent', { again: true })),
  );
  return (
    <main aria-label="Check your mail" style={page}>
      <h1>Check your mail</h1>
      <p>We have sent you a message with a link in it. Open the link to confirm your address.</p>
      <p>If it has not come in a few minutes, look in your spam folder, then ask for it again.</p>
      {again ? <p role="status">We have sent it again.</p> : null}
      <Problem failure={resend.failure} />
      <button type="button" onClick={resend.go} disabled={resend.busy}>
        Send it again
      </button>
      <p>
        You do not have to wait: <a href={screenHref({ onboarding: true })}>carry on</a> and confirm later.
      </p>
    </main>
  );
}

export function VerifyScreen({ identity, code }: { readonly identity: IdentityApi; readonly code: string }): JSX.Element {
  const confirmed = useRemote(() => identity.verify(code));
  return (
    <main aria-label="Confirm your address" style={page}>
      {confirmed.status === 'loading' ? <p role="status">Confirming your address…</p> : null}
      {confirmed.status === 'loaded' ? (
        <>
          <h1>Your address is confirmed</h1>
          <p>Next, tell us about your exam so we can start you in the right place.</p>
          <a href={screenHref({ onboarding: true })}>Continue</a>
        </>
      ) : null}
      {confirmed.status === 'failed' ? (
        <>
          <h1>That link did not work</h1>
          <p>{confirmed.message}</p>
          <p>
            <a href={authHref('signin')}>Sign in</a> and we can send you a new one.
          </p>
        </>
      ) : null}
    </main>
  );
}

export function RecoverScreen({ identity, asked, onOpen }: { readonly identity: IdentityApi; readonly asked: boolean; readonly onOpen: (href: string) => void }): JSX.Element {
  const ask = useSubmit(({ form }: Entry) => identity.requestRecovery(text(form, 'email')), () => onOpen(authHref('recover', { asked: true })));
  return (
    <main aria-label="Recover your password" style={page}>
      <h1>Forgotten your password?</h1>
      <p>Tell us your email address and, if it has an account, we will send you a link to choose a new password.</p>
      {asked ? <p role="status">If that address has an account, a message is on its way.</p> : null}
      <form aria-label="Recover your password" onSubmit={sent(ask.go)}>
        <Email autoComplete="username" />
        <Problem failure={ask.failure} />
        <button type="submit" disabled={ask.busy}>
          Send the link
        </button>
      </form>
      <p>
        <a href={authHref('signin')}>Back to sign in</a>
      </p>
    </main>
  );
}

export function ResetScreen({ identity, code, onOpen }: { readonly identity: IdentityApi; readonly code: string; readonly onOpen: (href: string) => void }): JSX.Element {
  const choose = useSubmit(({ form }: Entry) => identity.reset(code, text(form, 'password')), () => onOpen(authHref('signin', { changed: true })));
  return (
    <main aria-label="Choose a new password" style={page}>
      <h1>Choose a new password</h1>
      <form aria-label="Choose a new password" onSubmit={sent(choose.go)}>
        <Password label="New password" autoComplete="new-password" hint="At least 12 characters." />
        <Problem failure={choose.failure} />
        <button type="submit" disabled={choose.busy}>
          Save the new password
        </button>
      </form>
      <p>
        Did the link stop working? <a href={authHref('recover')}>Ask for a new one</a>
      </p>
    </main>
  );
}
