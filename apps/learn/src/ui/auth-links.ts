/**
 * Where a person is on the way in, as an address (M8-43). The screens that let a stranger in are chosen by `auth` the way the others are chosen by their own parameter, so a screen holds no
 * memory of where it was: reopening the page at the address is reopening the screen. A link in a message carries its code after `#`, which a browser does not send to any server or
 * to another site.
 */
export type AuthScreen = 'signin' | 'register' | 'recover' | 'sent';

export interface AuthFlags {
  /** The password was just changed, so the sign-in screen says so. */
  readonly changed?: boolean;
  /** A new message was just asked for, so the check-your-mail screen says so. */
  readonly again?: boolean;
  /** A recovery message was just asked for. */
  readonly asked?: boolean;
}

export function authHref(screen: AuthScreen, flags: AuthFlags = {}): string {
  const params = new URLSearchParams({ auth: screen });
  if (flags.changed === true) params.set('changed', '1');
  if (flags.again === true) params.set('again', '1');
  if (flags.asked === true) params.set('asked', '1');
  return `?${params.toString()}`;
}

/** What a link in a message asked for: confirm an address, or choose a new password. */
export type MessageLink = { readonly kind: 'verify' | 'reset'; readonly code: string };

/** The link a message carried, from the part of the address after `#`; `null` for anything else. */
export function messageLinkOf(hash: string): MessageLink | null {
  const match = /^#(verify|reset)=([A-Za-z0-9_-]{8,256})$/u.exec(hash);
  return match === null ? null : { kind: match[1] as 'verify' | 'reset', code: match[2] as string };
}

/** The address a person returns to after signing in: the one they came to, without the parameters that belong to the way in. */
export function returnAddress(search: string): string {
  const params = new URLSearchParams(search);
  for (const name of ['auth', 'changed', 'again', 'asked']) params.delete(name);
  const rest = params.toString();
  return rest === '' ? '?' : `?${rest}`;
}
