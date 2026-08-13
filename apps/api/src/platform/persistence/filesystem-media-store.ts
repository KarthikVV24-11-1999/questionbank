import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { NodeEnv } from '../config/config.js';

/**
 * Content's `MediaStore` port (`contexts/content/application/ports.ts`),
 * implemented unchanged: `put(bytes, contentType)` and `head(storageKey)`,
 * nothing else — there is no `delete` on the port, so this adapter has
 * none either.
 *
 * The production implementation is S3, and `@aws-sdk/client-s3` is not in
 * the offline store (**D32**, trigger: the SDK becoming installable). This
 * is the filesystem adapter — for local development and for a Compose
 * deployment that has not yet been given S3 credentials — and the
 * composition root refuses to select it once `nodeEnv` is `production`
 * (below), so a hurried deploy cannot end up shipping local disk as its
 * object store by omission.
 */
export interface StoredObject {
  readonly storageKey: string;
  readonly checksum: string;
  readonly contentType: string;
  readonly byteLength: number;
}

export interface MediaStore {
  put(bytes: Uint8Array, contentType: string): Promise<StoredObject>;
  head(storageKey: string): Promise<StoredObject | undefined>;
}

export class InvalidStorageKeyError extends Error {
  constructor(storageKey: string) {
    super(`storage key is not a valid content-address: ${JSON.stringify(storageKey)}`);
    this.name = 'InvalidStorageKeyError';
  }
}

export class ProductionMediaStoreRefusedError extends Error {
  constructor() {
    super(
      'FilesystemMediaStore may not be selected when NODE_ENV is production — ' +
        'no S3 adapter exists yet (D32); this is a boot failure, not a warning',
    );
    this.name = 'ProductionMediaStoreRefusedError';
  }
}

/** A storage key is always a lowercase sha256 hex digest — nothing else is ever produced or accepted. */
const STORAGE_KEY_PATTERN = /^[0-9a-f]{64}$/u;

function checksumOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Sharded two levels deep, S3-prefix-style, so one directory never holds every object. */
function pathFor(root: string, checksum: string): string {
  return join(root, checksum.slice(0, 2), checksum.slice(2, 4), checksum);
}

interface StoredMeta {
  readonly contentType: string;
  readonly byteLength: number;
}

export interface FilesystemMediaStoreConfig {
  readonly mediaStorageRoot: string;
}

export class FilesystemMediaStore implements MediaStore {
  readonly #root: string;

  constructor(config: FilesystemMediaStoreConfig) {
    this.#root = config.mediaStorageRoot;
  }

  async put(bytes: Uint8Array, contentType: string): Promise<StoredObject> {
    const checksum = checksumOf(bytes);
    const objectPath = pathFor(this.#root, checksum);
    await mkdir(dirname(objectPath), { recursive: true });
    await writeFile(objectPath, bytes);
    const meta: StoredMeta = { contentType, byteLength: bytes.byteLength };
    await writeFile(`${objectPath}.meta.json`, JSON.stringify(meta));
    return { storageKey: checksum, checksum, contentType, byteLength: bytes.byteLength };
  }

  /** Rejects a malformed key before it ever reaches the filesystem — no path traversal shape gets that far. */
  async head(storageKey: string): Promise<StoredObject | undefined> {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new InvalidStorageKeyError(storageKey);
    }
    const objectPath = pathFor(this.#root, storageKey);
    let meta: StoredMeta;
    try {
      meta = JSON.parse(await readFile(`${objectPath}.meta.json`, 'utf8')) as StoredMeta;
      await stat(objectPath);
    } catch {
      return undefined;
    }
    return { storageKey, checksum: storageKey, contentType: meta.contentType, byteLength: meta.byteLength };
  }
}

/**
 * The one place `nodeEnv` and `MediaStore` selection meet. `createApplication`
 * (M0-12) calls this and lets a thrown `ProductionMediaStoreRefusedError`
 * propagate — an uncaught error during composition is a boot failure, which
 * is the only refusal a hurried deploy cannot ignore.
 */
export function createMediaStore(config: FilesystemMediaStoreConfig & { readonly nodeEnv: NodeEnv }): MediaStore {
  if (config.nodeEnv === 'production') {
    throw new ProductionMediaStoreRefusedError();
  }
  return new FilesystemMediaStore(config);
}
