import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeIdentityApi } from '../testing/identity-fakes.js';
import { refusal } from '../testing/profile-fakes.js';
import { expectNoDomainVocabulary } from '../testing/vocabulary.js';
import type { AuthFlags, AuthScreen, MessageLink } from './auth-links.js';
import { AuthGate } from './AuthGate.js';

afterEach(cleanup);

function open(over: { identity?: FakeIdentityApi; link?: MessageLink | null; screen?: AuthScreen | null; flags?: AuthFlags; returnTo?: string; offerSignOut?: boolean } = {}) {
  const identity = over.identity ?? new FakeIdentityApi();
  const onOpen = vi.fn();
  const view = render(
    <AuthGate identity={identity} link={over.link ?? null} auth={{ screen: over.screen ?? null, flags: over.flags ?? {} }} returnTo={over.returnTo ?? '?'} offerSignOut={over.offerSignOut ?? true} onOpen={onOpen} waitFor={() => () => undefined}>
      <p>The app</p>
    </AuthGate>,
  );
  return { identity, onOpen, view };
}
const signedIn = () => Object.assign(new FakeIdentityApi(), { session: true });

describe('who sees the app', () => {
  it('a person with a session sees it, and a way to sign out', async () => {
    open({ identity: signedIn() });
    expect(await screen.findByText('The app')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Your account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('waits for the server before showing anything, rather than showing the app and then taking it away', () => {
    open();
    expect(screen.getByRole('status')).toHaveTextContent('Opening');
    expect(screen.queryByText('The app')).toBeNull();
  });

  it('a person without one sees the way in and not the app, and is taken back to where they came to once in', async () => {
    const { identity, onOpen } = open({ returnTo: '?topic=physics' });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('The app')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    await userEvent.type(screen.getByLabelText('Email address'), 'asha@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'three ordinary words together');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('?topic=physics'));
    expect(identity.session).toBe(true);
  });

  it('opens the screen the address names for a person without a session: creating an account, or asking for a new password', async () => {
    open({ screen: 'register' });
    expect(await screen.findByRole('heading', { name: 'Create an account' })).toBeInTheDocument();
    cleanup();
    open({ screen: 'recover', flags: { asked: true } });
    expect(await screen.findByRole('heading', { name: 'Forgotten your password?' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('a message is on its way');
    cleanup();
    open({ screen: 'signin', flags: { changed: true } });
    expect(await screen.findByText(/Your password is changed\./u)).toBeInTheDocument();
  });

  it('tells a person whose session a later sign-in ended so, in a learner\'s words, and a person whose session ended any other way nothing of it', async () => {
    const ended = new FakeIdentityApi();
    ended.endedBy = 'another_sign_in';
    const view = open({ identity: ended }).view;
    expect(await screen.findByText(/You were signed out because your account was signed in on another device\./u)).toBeInTheDocument();
    expectNoDomainVocabulary(view.container);
    expect((await axe.run(view.container)).violations).toEqual([]);
    cleanup();
    open();
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.queryByText(/signed in on another device/u)).toBeNull();
  });

  it('shows the app, not a way in, to someone who is signed in and opens an address for the way in', async () => {
    open({ identity: signedIn(), screen: 'register' });
    expect(await screen.findByText('The app')).toBeInTheDocument();
  });
});

describe('being signed out is only ever the server\'s word', () => {
  it('a connection that is down shows the app, which says what it cannot do offline, and offers no sign out it cannot honour', async () => {
    const identity = new FakeIdentityApi();
    identity.refuse.signedIn = new TypeError('Failed to fetch');
    open({ identity });
    expect(await screen.findByText('The app')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('a server that is failing shows the app too', async () => {
    const identity = new FakeIdentityApi();
    identity.refuse.signedIn = refusal(503, 'The service is unavailable. Try again shortly.');
    open({ identity });
    expect(await screen.findByText('The app')).toBeInTheDocument();
  });
});

describe('signing out', () => {
  it('ends the session and opens the sign-in screen', async () => {
    const { identity, onOpen } = open({ identity: signedIn() });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('?auth=signin'));
    expect(identity.calls).toEqual(['signedIn', 'logout']);
    expect(identity.session).toBe(false);
  });

  it('says so when it could not, and stays signed in', async () => {
    const identity = signedIn();
    identity.refuse.logout = refusal(503, 'The service is unavailable. Try again shortly.');
    const { onOpen } = open({ identity });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again shortly.');
    expect(onOpen).not.toHaveBeenCalled();
    expect(identity.session).toBe(true);
  });

  it('is not offered while a paper is being sat', async () => {
    open({ identity: signedIn(), offerSignOut: false });
    expect(await screen.findByText('The app')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});

describe('a link from a message', () => {
  it('confirming an address opens the confirmation whether or not there is a session, and does not ask the server who is signed in first', async () => {
    const identity = new FakeIdentityApi();
    open({ identity, link: { kind: 'verify', code: 'CODE-123456' } });
    expect(await screen.findByRole('heading', { name: 'Your address is confirmed' })).toBeInTheDocument();
    expect(identity.calls).toEqual(['verify CODE-123456']);
    expect(screen.queryByText('The app')).toBeNull();
  });

  it('choosing a new password opens that, and sends the code in the link with the password', async () => {
    const identity = new FakeIdentityApi();
    const { onOpen } = open({ identity, link: { kind: 'reset', code: 'CODE-123456' } });
    await userEvent.type(await screen.findByLabelText('New password'), 'three ordinary words together');
    await userEvent.click(screen.getByRole('button', { name: 'Save the new password' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('?auth=signin&changed=1'));
    expect(identity.calls).toEqual(['reset CODE-123456 three ordinary words together']);
  });

  it('the link wins over the address: a person who opens it is not sent to sign in first', async () => {
    open({ link: { kind: 'verify', code: 'CODE-123456' }, screen: 'signin' });
    expect(await screen.findByRole('heading', { name: 'Your address is confirmed' })).toBeInTheDocument();
  });
});

describe('after creating an account', () => {
  it('says to check mail, before asking the server anything, so a person who was signed in by registering is not shown the app first', async () => {
    const identity = new FakeIdentityApi();
    open({ identity, screen: 'sent', flags: { again: true } });
    expect(await screen.findByRole('heading', { name: 'Check your mail' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('We have sent it again.');
    expect(identity.calls).toEqual([]);
  });
});

describe('what a person reads', () => {
  it('uses none of our words and has no accessibility violations, signed in or out', async () => {
    const out = open();
    await screen.findByRole('heading', { name: 'Sign in' });
    expectNoDomainVocabulary(out.view.container);
    expect((await axe.run(out.view.container)).violations).toEqual([]);
    cleanup();
    const inn = open({ identity: signedIn() });
    await screen.findByText('The app');
    expectNoDomainVocabulary(inn.view.container);
    expect((await axe.run(inn.view.container)).violations).toEqual([]);
  });
});
