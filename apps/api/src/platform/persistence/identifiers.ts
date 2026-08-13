import { randomUUID } from 'node:crypto';

/**
 * Content, curriculum and scoring each declare their own `IdentifierFactory`
 * independently, structurally identical (`next(): string`). One production
 * implementation serves all three.
 */
export interface IdentifierFactory {
  next(): string;
}

export class UuidIdentifierFactory implements IdentifierFactory {
  next(): string {
    return randomUUID();
  }
}
