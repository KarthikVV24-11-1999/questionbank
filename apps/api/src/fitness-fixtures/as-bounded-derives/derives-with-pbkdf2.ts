import { pbkdf2 } from 'node:crypto';

/** Planted: key derivation outside the hasher, by the other function a password is commonly hashed with. */
export const derive = (password: string, salt: Buffer, done: (error: Error | null, key: Buffer) => void): void => pbkdf2(password, salt, 1000, 32, 'sha256', done);
