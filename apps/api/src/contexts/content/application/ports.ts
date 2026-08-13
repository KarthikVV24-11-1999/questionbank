import { createHash } from 'node:crypto';
import type { PrincipalRef } from '@questionbank/domain-types';
import type { ItemVersion } from '../domain/item-version.js';
import type { RenderVerdict } from '../domain/publication-preconditions.js';
import type { AuthorizationContext } from './authorization.js';

export interface ApplicationContext extends AuthorizationContext {
  readonly correlationId: string;
}

/**
 * One row per consequential command (DATA-ARCHITECTURE P3, INV-02). Deleting a
 * draft is permanent, so the audit record is the only remaining evidence the
 * item ever existed (FR-TCH-06 rule 3) — it therefore names the principal, the
 * action and the target, and never the content itself (§7).
 *
 * D4 replaces the in-memory implementation with a durable one.
 */
export interface AuditRecord {
  readonly principal: PrincipalRef;
  readonly action: string;
  readonly targetContext: 'content';
  readonly targetType: string;
  readonly targetId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  /** Why, where a transition or a deletion needs one (INV-02). */
  readonly justification?: string;
}

export interface AuditRecorder {
  record(entry: AuditRecord): Promise<void>;
}

/**
 * The clock lives here, not in the domain. Every instant the content domain
 * reasons about — a version's `createdAt`, a licence's `asOf` — is supplied,
 * so it is read once at this boundary and passed in.
 */
export interface Clock {
  now(): Date;
}

export interface IdentifierFactory {
  next(): string;
}

/**
 * Autosave's retry guard (FR-TCH-02 rule 6).
 *
 * A draft edit is idempotent on a key rather than on its content: two saves
 * carrying the same key are the same save retried, and the second must not
 * bump the aggregate version, rewrite the row or write a second audit record.
 * Content-equality would answer a different question — it cannot tell a retry
 * from an author typing a character and deleting it again.
 *
 * In-memory here, as `AuditRecorder` is. A process-local store makes a retry
 * on the same connection a no-op and a retry that lands on another instance a
 * redundant rewrite of identical content, which is safe but not free — the
 * durable adapter is M0's, and swapping it is a wiring change.
 */
export interface IdempotencyStore {
  /** True when this key has already been applied, in which case nothing is written. */
  seen(key: string): Promise<boolean>;
  remember(key: string): Promise<void>;
}

/**
 * What the store knows about an object. **The checksum comes from here and
 * never from a caller** — a caller-supplied checksum verifies nothing, since
 * whoever replaced the object would supply the new one.
 */
export interface StoredObject {
  readonly storageKey: string;
  readonly checksum: string;
  readonly contentType: string;
  readonly byteLength: number;
}

/**
 * Bytes live outside the database (DEC-6, DATA-ARCHITECTURE). **This interface
 * is the only place in the content context where a byte array is named**, and
 * it is named here so that no command, handler, DTO, route or event has to —
 * a source scan asserts exactly that.
 *
 * `put` belongs to the upload edge (M0's adapter, reached from an authoring
 * route); the handlers here only ever `head`, because registration records
 * what the store already holds rather than moving bytes itself.
 */
export interface MediaStore {
  put(bytes: Uint8Array, contentType: string): Promise<StoredObject>;
  head(storageKey: string): Promise<StoredObject | undefined>;
}

/**
 * The render verdict M3-11 requires as a supplied fact (INV-14, FR-QM-14
 * rule 2). Produced by `packages/content-renderer/`'s `validateRender`
 * (M3-38); declared here as a port so the publication handler depends on the
 * verdict rather than on the renderer.
 *
 * There is deliberately no default. A publication handler that could not reach
 * the renderer must refuse, not assume — an item that has never been checked
 * on the minimum device profile is exactly the one that breaks there.
 *
 * **No production adapter exists yet, and that is a composition gap rather
 * than a design one.** `validateRender` produces exactly this verdict, but
 * calling it from the API means running a React render inside the Node
 * service, which needs a composition root — and there is no running
 * application in this repository (M0). Recorded as debt D27 so the gap is
 * visible: today the precondition is enforced against a fact only a test
 * supplies.
 */
export interface RenderValidator {
  validate(version: ItemVersion): Promise<RenderVerdict>;
}

/**
 * Whether a reviewer has started on a version (FR-TCH-08 rule 2). Assignment
 * is M4's, so M4 supplies the adapter; M3 ships the port and the refusal.
 *
 * Until M4 lands, nothing in this milestone claims a version, so withdrawal
 * while `in_review` is always permitted. That is stated rather than hidden:
 * the rule is enforced here, and the data that would trip it arrives later.
 */
export interface ReviewProgress {
  hasBegun(itemVersionId: string): Promise<boolean>;
}

export class InMemoryReviewProgress implements ReviewProgress {
  readonly #claimed = new Set<string>();

  async hasBegun(itemVersionId: string): Promise<boolean> {
    return this.#claimed.has(itemVersionId);
  }

  claim(itemVersionId: string): void {
    this.#claimed.add(itemVersionId);
  }
}

/**
 * What a principal's plan grants (D9). Derived at evaluation time and never
 * stored, so Content asks rather than reads.
 *
 * **Basic correctness is never asked about** (INV-08): the delivery solution
 * query consults this only for the paid depth, so an entitlement service that
 * is unreachable cannot withhold the correct answer.
 */
export interface Entitlements {
  allows(principal: PrincipalRef, capability: string): Promise<boolean>;
}

export class InMemoryEntitlements implements Entitlements {
  readonly #granted = new Map<string, Set<string>>();

  async allows(principal: PrincipalRef, capability: string): Promise<boolean> {
    return this.#granted.get(principal.id)?.has(capability) ?? false;
  }

  grant(principalId: string, capability: string): void {
    const held = this.#granted.get(principalId) ?? new Set<string>();
    held.add(capability);
    this.#granted.set(principalId, held);
  }
}

export class InMemoryAuditRecorder implements AuditRecorder {
  readonly entries: AuditRecord[] = [];

  async record(entry: AuditRecord): Promise<void> {
    this.entries.push(entry);
  }

  entriesFor(targetId: string): readonly AuditRecord[] {
    return this.entries.filter((entry) => entry.targetId === targetId);
  }
}

/**
 * The test double for `MediaStore`. The real adapter is M0's object storage,
 * and swapping it is a wiring change — which is the whole reason the port
 * exists rather than the handlers reaching for a bucket.
 */
export class InMemoryMediaStore implements MediaStore {
  readonly #objects = new Map<string, StoredObject>();
  #next = 0;

  async put(bytes: Uint8Array, contentType: string): Promise<StoredObject> {
    this.#next += 1;
    const stored: StoredObject = Object.freeze({
      storageKey: `content/media/object-${this.#next}`,
      checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      contentType,
      byteLength: bytes.byteLength,
    });
    this.#objects.set(stored.storageKey, stored);
    return stored;
  }

  async head(storageKey: string): Promise<StoredObject | undefined> {
    return this.#objects.get(storageKey);
  }

  /**
   * Replaces the object behind a key — the case the checksum exists to catch.
   * Unconditional, because "replace something that is not there" is not a
   * scenario worth a branch nothing meaningful can reach.
   */
  async replace(storageKey: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.#objects.set(
      storageKey,
      Object.freeze({
        storageKey,
        checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        contentType,
        byteLength: bytes.byteLength,
      }),
    );
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #keys = new Set<string>();

  async seen(key: string): Promise<boolean> {
    return this.#keys.has(key);
  }

  async remember(key: string): Promise<void> {
    this.#keys.add(key);
  }
}
