import type { JSX, ReactNode } from 'react';
import type { IdentityApi } from '../api/identity-api.js';
import { TOKENS } from '../tokens.js';
import { authHref, type AuthFlags, type AuthScreen, type MessageLink } from './auth-links.js';
import { CheckMailScreen, RecoverScreen, RegisterScreen, ResetScreen, SignInScreen, VerifyScreen } from './AuthScreens.js';
import { useAction, useRemote } from './use-remote.js';

/**
 * Who may see the product (M8-43). A person with a session sees the app; a person without one sees the way in; a link from a message opens the screen it was sent for, session or none.
 *
 * **Being signed out is only ever the server's word.** The question is asked of the server, and only its "who are you" (401) sends a person to sign in. A connection that is down, or a server
 * that is failing, shows the app, which already says plainly what it cannot do offline: a learner part-way through a paper on a poor line must not be turned out of it because a check could not
 * be made.
 */
export interface AuthGateProps {
  readonly identity: IdentityApi;
  /** What a link in a message asked for, if the page was opened from one. */
  readonly link: MessageLink | null;
  /** Which way-in screen the address names, and what it says has just happened. */
  readonly auth: { readonly screen: AuthScreen | null; readonly flags: AuthFlags };
  /** Where a person goes once signed in: the address they came to. */
  readonly returnTo: string;
  /** Whether the sign-out control is offered: not while a paper is being sat. */
  readonly offerSignOut: boolean;
  readonly onOpen: (href: string) => void;
  readonly children: ReactNode;
}

export function AuthGate(props: AuthGateProps): JSX.Element {
  const { identity, link, auth, returnTo, onOpen } = props;
  if (link !== null) return link.kind === 'verify' ? <VerifyScreen identity={identity} code={link.code} /> : <ResetScreen identity={identity} code={link.code} onOpen={onOpen} />;
  if (auth.screen === 'sent') return <CheckMailScreen identity={identity} again={auth.flags.again === true} onOpen={onOpen} />;
  return <Checked {...props} returnTo={returnTo} />;
}

function Checked({ identity, auth, returnTo, offerSignOut, onOpen, children }: AuthGateProps): JSX.Element {
  const signedIn = useRemote(() => identity.signedIn());
  if (signedIn.status === 'loading') return <p role="status" style={{ padding: TOKENS.spaceMedium }}>Opening…</p>;
  if (signedIn.status === 'loaded' && !signedIn.value) {
    if (auth.screen === 'register') return <RegisterScreen identity={identity} onOpen={onOpen} />;
    if (auth.screen === 'recover') return <RecoverScreen identity={identity} asked={auth.flags.asked === true} onOpen={onOpen} />;
    return <SignInScreen identity={identity} returnTo={returnTo} changed={auth.flags.changed === true} onOpen={onOpen} />;
  }
  return (
    <>
      {signedIn.status === 'loaded' && offerSignOut ? <SignOut identity={identity} onOpen={onOpen} /> : null}
      {children}
    </>
  );
}

function SignOut({ identity, onOpen }: { readonly identity: IdentityApi; readonly onOpen: (href: string) => void }): JSX.Element {
  const out = useAction(() => identity.logout(), () => onOpen(authHref('signin')));
  return (
    <nav aria-label="Your account" style={{ padding: TOKENS.spaceSmall, textAlign: 'right' }}>
      <button type="button" onClick={out.go} disabled={out.busy}>
        Sign out
      </button>
      {out.failure === null ? null : <span role="alert"> {out.failure}</span>}
    </nav>
  );
}
