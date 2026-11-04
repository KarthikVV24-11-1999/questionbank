import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeIdentityApi } from '../testing/identity-fakes.js';
import { refusal } from '../testing/profile-fakes.js';
import { expectNoDomainVocabulary } from '../testing/vocabulary.js';
import { CheckMailScreen, RecoverScreen, RegisterScreen, ResetScreen, SignInScreen, VerifyScreen } from './AuthScreens.js';

afterEach(cleanup);

const EMAIL = 'asha@example.com';
const PASSWORD = 'three ordinary words together';

async function fill(label: RegExp | string, value: string): Promise<void> {
  await userEvent.type(screen.getByLabelText(label), value);
}

describe('signing in', () => {
  function open(over: { returnTo?: string; changed?: boolean; identity?: FakeIdentityApi } = {}) {
    const identity = over.identity ?? new FakeIdentityApi();
    const onOpen = vi.fn();
    const view = render(<SignInScreen identity={identity} returnTo={over.returnTo ?? '?'} changed={over.changed ?? false} onOpen={onOpen} />);
    return { identity, onOpen, view };
  }

  it('signs in with what was typed and goes back to where the person came to', async () => {
    const { identity, onOpen } = open({ returnTo: '?practice=run-7' });
    await fill('Email address', EMAIL);
    await fill('Password', PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('?practice=run-7'));
    expect(identity.calls).toEqual([`login ${EMAIL} ${PASSWORD}`]);
  });

  it('says what the server said when it will not, stays where it is, and lets the person try again', async () => {
    const identity = new FakeIdentityApi();
    identity.refuse.login = refusal(401, 'The email or password is not right.');
    const { onOpen } = open({ identity });
    await fill('Email address', EMAIL);
    await fill('Password', 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The email or password is not right.');
    expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalled());
  });

  it('offers the other ways in: creating an account and asking for a new password', () => {
    open();
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute('href', '?auth=register');
    expect(screen.getByRole('link', { name: 'Forgotten your password?' })).toHaveAttribute('href', '?auth=recover');
  });

  it('tells a person whose password has just changed so, and otherwise says nothing of it', () => {
    open({ changed: true });
    expect(screen.getByRole('status')).toHaveTextContent('Your password is changed.');
    cleanup();
    open();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('asks for the address and the password in fields a password manager recognises', () => {
    open();
    expect(screen.getByLabelText('Email address')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Email address')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('uses none of our words and has no accessibility violations', async () => {
    const { view } = open({ changed: true });
    expectNoDomainVocabulary(view.container);
    expect((await axe.run(view.container)).violations).toEqual([]);
  });
});

describe('creating an account', () => {
  function open(identity = new FakeIdentityApi()) {
    const onOpen = vi.fn();
    const view = render(<RegisterScreen identity={identity} onOpen={onOpen} />);
    return { identity, onOpen, view };
  }

  it('registers, then signs the person in with the same password so the next screen can ask for the message again, then says to check mail', async () => {
    const { identity, onOpen } = open();
    await fill('Email address', EMAIL);
    await fill('Choose a password', PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('?auth=sent'));
    expect(identity.calls).toEqual([`register ${EMAIL} ${PASSWORD}`, `login ${EMAIL} ${PASSWORD}`]);
  });

  it('still says to check mail when the address already had an account and so could not be signed in: the answer must not differ', async () => {
    const identity = new FakeIdentityApi();
    identity.refuse.login = refusal(401, 'The email or password is not right.');
    const { onOpen } = open(identity);
    await fill('Email address', EMAIL);
    await fill('Choose a password', PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('?auth=sent'));
  });

  it('says why when the password is not accepted, signs nobody in, and stays', async () => {
    const identity = new FakeIdentityApi();
    identity.refuse.register = refusal(400, 'That password is not acceptable: use at least 12 characters.');
    const { onOpen } = open(identity);
    await fill('Email address', EMAIL);
    await fill('Choose a password', PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('use at least 12 characters');
    expect(identity.calls.some((call) => call.startsWith('login'))).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('tells the person what a good password is before they choose, asks for a new one to be remembered, and links back to signing in', () => {
    open();
    expect(screen.getByLabelText('Choose a password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('Choose a password')).toHaveAttribute('minlength', '12');
    expect(screen.getByText(/At least 12 characters/u)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '?auth=signin');
  });

  it('uses none of our words and has no accessibility violations', async () => {
    const { view } = open();
    expectNoDomainVocabulary(view.container);
    expect((await axe.run(view.container)).violations).toEqual([]);
  });
});

describe('checking mail', () => {
  function open(over: { again?: boolean; identity?: FakeIdentityApi } = {}) {
    const identity = over.identity ?? new FakeIdentityApi();
    const onOpen = vi.fn();
    const view = render(<CheckMailScreen identity={identity} again={over.again ?? false} onOpen={onOpen} />);
    return { identity, onOpen, view };
  }

  it('says a message with a link has been sent, what to do if it has not come, and that nothing waits on it', () => {
    open();
    expect(screen.getByRole('heading', { name: 'Check your mail' })).toBeInTheDocument();
    expect(screen.getByText(/look in your spam folder/u)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'carry on' })).toHaveAttribute('href', '?onboarding=1');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('asks for the message again, and reopens itself saying it has been sent again', async () => {
    const { identity, onOpen } = open();
    await userEvent.click(screen.getByRole('button', { name: 'Send it again' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('?auth=sent&again=1'));
    expect(identity.calls).toEqual(['resendVerification']);
    cleanup();
    open({ again: true });
    expect(screen.getByRole('status')).toHaveTextContent('We have sent it again.');
  });

  it('says to sign in when there is no session to ask from, in words that do not name one', async () => {
    const identity = new FakeIdentityApi();
    identity.refuse.resendVerification = refusal(401, 'Authentication is required.');
    const { onOpen } = open({ identity });
    await userEvent.click(screen.getByRole('button', { name: 'Send it again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in, then ask for it again.');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('says what the server said when the message could not be sent just now, and lets the person ask again', async () => {
    const identity = new FakeIdentityApi();
    identity.refuse.resendVerification = refusal(503, 'The message could not be sent just now. Try again shortly.');
    const { onOpen } = open({ identity });
    await userEvent.click(screen.getByRole('button', { name: 'Send it again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again shortly.');
    await userEvent.click(screen.getByRole('button', { name: 'Send it again' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('?auth=sent&again=1'));
  });

  it('uses none of our words and has no accessibility violations', async () => {
    const { view } = open({ again: true });
    expectNoDomainVocabulary(view.container);
    expect((await axe.run(view.container)).violations).toEqual([]);
  });
});

describe('confirming an address from the link in a message', () => {
  it('spends the code, says the address is confirmed, and continues to the questions about the exam and not to an empty home', async () => {
    const identity = new FakeIdentityApi();
    const view = render(<VerifyScreen identity={identity} code="CODE-123456" />);
    expect(screen.getByRole('status')).toHaveTextContent('Confirming your address');
    expect(await screen.findByRole('heading', { name: 'Your address is confirmed' })).toBeInTheDocument();
    expect(identity.calls).toEqual(['verify CODE-123456']);
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute('href', '?onboarding=1');
    expectNoDomainVocabulary(view.container);
    expect((await axe.run(view.container)).violations).toEqual([]);
  });

  it('says so when the link no longer works, and says how to get another', async () => {
    const identity = new FakeIdentityApi();
    identity.refuse.verify = refusal(400, 'That link is not valid any longer.');
    render(<VerifyScreen identity={identity} code="CODE-123456" />);
    expect(await screen.findByRole('heading', { name: 'That link did not work' })).toBeInTheDocument();
    expect(screen.getByText('That link is not valid any longer.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '?auth=signin');
    expect(screen.queryByRole('link', { name: 'Continue' })).toBeNull();
  });
});

describe('asking for a recovery message', () => {
  function open(over: { asked?: boolean; identity?: FakeIdentityApi } = {}) {
    const identity = over.identity ?? new FakeIdentityApi();
    const onOpen = vi.fn();
    const view = render(<RecoverScreen identity={identity} asked={over.asked ?? false} onOpen={onOpen} />);
    return { identity, onOpen, view };
  }

  it('asks, then reopens saying a message is on its way if the address has an account: the same words whether it does or not', async () => {
    const { identity, onOpen } = open();
    await fill('Email address', EMAIL);
    await userEvent.click(screen.getByRole('button', { name: 'Send the link' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('?auth=recover&asked=1'));
    expect(identity.calls).toEqual([`requestRecovery ${EMAIL}`]);
    cleanup();
    open({ asked: true });
    expect(screen.getByRole('status')).toHaveTextContent('If that address has an account, a message is on its way.');
  });

  it('says what the server said when it is asked too often, and links back to signing in', async () => {
    const identity = new FakeIdentityApi();
    identity.refuse.requestRecovery = refusal(429, 'Too many requests. Try again later.');
    open({ identity });
    await fill('Email address', EMAIL);
    await userEvent.click(screen.getByRole('button', { name: 'Send the link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests.');
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '?auth=signin');
  });

  it('uses none of our words and has no accessibility violations', async () => {
    const { view } = open({ asked: true });
    expectNoDomainVocabulary(view.container);
    expect((await axe.run(view.container)).violations).toEqual([]);
  });
});

describe('choosing a new password', () => {
  function open(identity = new FakeIdentityApi()) {
    const onOpen = vi.fn();
    const view = render(<ResetScreen identity={identity} code="CODE-123456" onOpen={onOpen} />);
    return { identity, onOpen, view };
  }

  it('sends the code with the new password and goes to signing in, saying the password has changed', async () => {
    const { identity, onOpen } = open();
    await fill('New password', PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Save the new password' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('?auth=signin&changed=1'));
    expect(identity.calls).toEqual([`reset CODE-123456 ${PASSWORD}`]);
  });

  it('says why when the password or the link is refused, and offers a new link', async () => {
    const identity = new FakeIdentityApi();
    identity.refuse.reset = refusal(400, 'That link is not valid any longer.');
    const { onOpen } = open(identity);
    await fill('New password', PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Save the new password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That link is not valid any longer.');
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Ask for a new one' })).toHaveAttribute('href', '?auth=recover');
  });

  it('asks for a password to be remembered as a new one, and uses none of our words', async () => {
    const { view } = open();
    expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('New password')).toHaveAttribute('minlength', '12');
    expectNoDomainVocabulary(view.container);
    expect((await axe.run(view.container)).violations).toEqual([]);
  });
});
