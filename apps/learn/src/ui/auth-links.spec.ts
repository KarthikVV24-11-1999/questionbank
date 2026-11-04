import { describe, expect, it } from 'vitest';
import { authHref, messageLinkOf, returnAddress } from './auth-links.js';

describe('where a person is on the way in', () => {
  it('is an address that names the screen and what has just happened, and nothing about the person', () => {
    expect(authHref('signin')).toBe('?auth=signin');
    expect(authHref('signin', { changed: true })).toBe('?auth=signin&changed=1');
    expect(authHref('sent', { again: true })).toBe('?auth=sent&again=1');
    expect(authHref('recover', { asked: true })).toBe('?auth=recover&asked=1');
    expect(authHref('register', { changed: false, again: false, asked: false })).toBe('?auth=register');
  });

  it('reads a link from a message out of the part after the hash, and out of nothing else', () => {
    expect(messageLinkOf('#verify=abcdefgh_-12')).toEqual({ kind: 'verify', code: 'abcdefgh_-12' });
    expect(messageLinkOf('#reset=ZZZZZZZZ9999')).toEqual({ kind: 'reset', code: 'ZZZZZZZZ9999' });
    for (const bad of ['', '#', '#verify=', '#verify=short', '#verify=has space', '#other=abcdefghijkl', 'verify=abcdefghijkl', '#verify=abcdefghijkl&x=1', `#reset=${'a'.repeat(257)}`]) expect(messageLinkOf(bad), bad).toBeNull();
    expect(messageLinkOf(`#reset=${'a'.repeat(256)}`)).not.toBeNull();
  });

  it('returns a person to where they came, without the parameters that belong to the way in', () => {
    expect(returnAddress('?auth=signin&changed=1')).toBe('?');
    expect(returnAddress('')).toBe('?');
    expect(returnAddress('?form=f1&session=s1&auth=signin&again=1&asked=1')).toBe('?form=f1&session=s1');
    expect(returnAddress('?onboarding=1')).toBe('?onboarding=1');
  });
});
