import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMediaStore,
  FilesystemMediaStore,
  InvalidStorageKeyError,
  ProductionMediaStoreRefusedError,
} from './filesystem-media-store.js';

let root: string;
let store: FilesystemMediaStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'media-store-'));
  store = new FilesystemMediaStore({ mediaStorageRoot: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FilesystemMediaStore — put/head round-trip', () => {
  it('put then head returns the same object, content-addressed by checksum', async () => {
    const bytes = new TextEncoder().encode('a diagram, as bytes');
    const stored = await store.put(bytes, 'image/svg+xml');

    expect(stored.storageKey).toBe(stored.checksum);
    expect(stored.storageKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored.contentType).toBe('image/svg+xml');
    expect(stored.byteLength).toBe(bytes.byteLength);

    const found = await store.head(stored.storageKey);
    expect(found).toEqual(stored);
  });

  it('two puts of identical bytes produce the same storage key — content addressing, not a counter', async () => {
    const bytes = new TextEncoder().encode('identical content');
    const first = await store.put(bytes, 'text/plain');
    const second = await store.put(bytes, 'text/plain');
    expect(first.storageKey).toBe(second.storageKey);
  });

  it('two puts of different bytes produce different storage keys', async () => {
    const a = await store.put(new TextEncoder().encode('a'), 'text/plain');
    const b = await store.put(new TextEncoder().encode('b'), 'text/plain');
    expect(a.storageKey).not.toBe(b.storageKey);
  });
});

describe('FilesystemMediaStore — head on a missing key returns the absence value, never throws', () => {
  it('a well-formed but never-stored key resolves to undefined', async () => {
    const neverStored = '0'.repeat(64);
    await expect(store.head(neverStored)).resolves.toBeUndefined();
  });
});

describe('FilesystemMediaStore — path traversal is rejected before any filesystem call', () => {
  const traversalShapes = [
    '../../../etc/passwd',
    '..%2f..%2fetc%2fpasswd',
    '/etc/passwd',
    'a/../../b',
    '..\\..\\windows\\system32',
    'not-a-checksum-at-all',
    '',
    'g'.repeat(64), // right length, not hex
  ];

  for (const shape of traversalShapes) {
    it(`rejects ${JSON.stringify(shape)}`, async () => {
      await expect(store.head(shape)).rejects.toThrow(InvalidStorageKeyError);
    });
  }
});

describe('createMediaStore — the composition-time production refusal', () => {
  it('returns a FilesystemMediaStore outside production', () => {
    const created = createMediaStore({ mediaStorageRoot: root, nodeEnv: 'development' });
    expect(created).toBeInstanceOf(FilesystemMediaStore);
  });

  it('refuses to select the filesystem adapter in production — a thrown boot failure, not a silent downgrade', () => {
    expect(() => createMediaStore({ mediaStorageRoot: root, nodeEnv: 'production' })).toThrow(
      ProductionMediaStoreRefusedError,
    );
  });

  it('still selects it under test', () => {
    const created = createMediaStore({ mediaStorageRoot: root, nodeEnv: 'test' });
    expect(created).toBeInstanceOf(FilesystemMediaStore);
  });
});
