import type { BoundedRunner, PasswordHasher } from '../application/ports.js';
import type { PasswordParameters, StoredCredential } from '../domain/password-hash.js';

/**
 * Every derive goes through one bound (M8-08, a `BoundedRunner`: the platform's `BoundedWork`, handed in by the composition root), the hash that makes a credential and the verify that checks one alike, so the bound is on the work and not on a route.
 * Wrapping the hasher, rather than guarding the handlers, is what makes the bound impossible to walk around: a handler written next year that derives is bounded the day it is
 * written.
 *
 * It is also what keeps a queue from becoming a way to tell addresses apart. Login for an address nobody holds verifies against a decoy, and registration hashes before it looks
 * the address up, so a known and an unknown address take the same number of turns at the same queue, and when the queue is full they are refused in the same way. The
 * saturation it throws is not caught here: the controller answers it, and answers it identically.
 */
export class BoundedPasswordHasher implements PasswordHasher {
  constructor(
    private readonly inner: PasswordHasher,
    private readonly bound: BoundedRunner,
  ) {}

  get parameters(): PasswordParameters {
    return this.inner.parameters;
  }

  hash(password: string): Promise<StoredCredential> {
    return this.bound.run(() => this.inner.hash(password));
  }

  verify(password: string, stored: StoredCredential): Promise<boolean> {
    return this.bound.run(() => this.inner.verify(password, stored));
  }
}
