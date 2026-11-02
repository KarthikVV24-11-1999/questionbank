import { scrypt } from 'node:crypto';

/** Planted: key derivation outside the hasher. */
export const derive = (password: string, salt: Buffer, done: (error: Error | null, key: Buffer) => void): void => void scrypt(password, salt, 32, done);
