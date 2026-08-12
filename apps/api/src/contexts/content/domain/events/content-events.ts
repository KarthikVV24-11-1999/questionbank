import type { PrincipalRef } from '@questionbank/domain-types';

/**
 * Facts published for downstream contexts (EVENT-TAXONOMY, §9 rule 4).
 *
 * **Identifiers only.** No stem, no option body, no answer key, no solution
 * text, no PII (§9 rules 10 and 12). Assessment pins an item version and reads
 * Content for the rest; Psychometrics keys on the version id. An event that
 * carried the content would be a second copy of it, diverging the first time
 * either side is corrected — and a copy of a key is a key, wherever it ends up.
 *
 * The temptation here is real: `ItemPublished` carrying the stem would save
 * every consumer a fetch. It is refused because the outbox is drained to
 * analytics (P4, and the relay in D17), and analytics is exactly where a key
 * must never arrive.
 */

export const CONTENT_EVENT_TYPES = [
  'ItemPublished',
  'ItemSuspended',
  'ItemRetired',
  'StimulusPublished',
  'SolutionPublished',
  'MediaAssetPublished',
] as const;

export type ContentEventType = (typeof CONTENT_EVENT_TYPES)[number];

export interface DomainEvent<TType extends string, TPayload> {
  readonly eventId: string;
  readonly eventType: TType;
  readonly schemaVersion: number;
  readonly occurredAt: Date;
  readonly principal: PrincipalRef;
  readonly correlationId: string;
  readonly payload: TPayload;
}

/**
 * What Assessment needs to pin a slot and what Psychometrics needs to key on —
 * and nothing more. `itemType` is here because form assembly filters on it and
 * would otherwise fetch every candidate item to find out.
 */
export interface ItemPublishedPayload {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly itemType: string;
  readonly versionNo: number;
  /** Where the content came from, for the content-health dashboard (FR-QM-05). */
  readonly sourceType: string;
  readonly primaryConceptIdentityId: string;
  readonly taxonomyVersionId: string;
  /** Present when the version supersedes an earlier published one. */
  readonly supersedesItemVersionId?: string;
}

/**
 * FR-QM-01 rule 4 — suspension removes student visibility immediately, so
 * every consumer that caches published content has to hear about it.
 */
export interface ItemSuspendedPayload {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly reason: string;
}

export interface ItemRetiredPayload {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly retirementReason: string;
  readonly replacedByItemId?: string;
}

export interface StimulusPublishedPayload {
  readonly stimulusId: string;
  readonly stimulusVersionId: string;
  readonly stimulusType: string;
  readonly versionNo: number;
}

/**
 * Carries no explanation text. The solution *is* the product's value and is
 * entitlement-gated (INV-08 gates only basic correctness); putting it in an
 * event would route it past that gate into analytics.
 */
export interface SolutionPublishedPayload {
  readonly solutionId: string;
  readonly solutionVersionId: string;
  readonly itemId: string;
  readonly targetItemVersionId: string;
}

export interface MediaAssetPublishedPayload {
  readonly assetId: string;
  readonly assetVersionId: string;
  readonly assetType: string;
  readonly mimeType: string;
}

export type ItemPublished = DomainEvent<'ItemPublished', ItemPublishedPayload>;
export type ItemSuspended = DomainEvent<'ItemSuspended', ItemSuspendedPayload>;
export type ItemRetired = DomainEvent<'ItemRetired', ItemRetiredPayload>;
export type StimulusPublished = DomainEvent<'StimulusPublished', StimulusPublishedPayload>;
export type SolutionPublished = DomainEvent<'SolutionPublished', SolutionPublishedPayload>;
export type MediaAssetPublished = DomainEvent<'MediaAssetPublished', MediaAssetPublishedPayload>;

export type ContentEvent =
  | ItemPublished
  | ItemSuspended
  | ItemRetired
  | StimulusPublished
  | SolutionPublished
  | MediaAssetPublished;

/**
 * Every event either has an analytics counterpart or an explicit exemption
 * (F18). The registry is what CI checks for completeness, and an exemption has
 * to be written down — "we did not think about it" and "it deliberately has
 * none" are indistinguishable without this.
 */
export interface EventRegistration {
  readonly eventType: ContentEventType;
  readonly schemaVersion: number;
  readonly analyticsEvent: string | null;
  readonly analyticsExemptionReason: string | null;
}

export const CONTENT_EVENT_REGISTRY: readonly EventRegistration[] = Object.freeze([
  Object.freeze({
    eventType: 'ItemPublished' as const,
    schemaVersion: 1,
    analyticsEvent: 'item.published',
    analyticsExemptionReason: null,
  }),
  Object.freeze({
    eventType: 'ItemSuspended' as const,
    schemaVersion: 1,
    analyticsEvent: 'item.suspended',
    analyticsExemptionReason: null,
  }),
  Object.freeze({
    eventType: 'ItemRetired' as const,
    schemaVersion: 1,
    analyticsEvent: 'item.retired',
    analyticsExemptionReason: null,
  }),
  Object.freeze({
    eventType: 'StimulusPublished' as const,
    schemaVersion: 1,
    // EVENT-TAXONOMY §3's content pipeline tracks the *item* funnel; a stimulus
    // is a component of an item and publishes no separate author-throughput
    // signal. Recorded rather than left blank.
    analyticsEvent: null,
    analyticsExemptionReason:
      'a stimulus is a component of an item; the authoring funnel is measured on item.* events',
  }),
  Object.freeze({
    eventType: 'SolutionPublished' as const,
    schemaVersion: 1,
    analyticsEvent: null,
    analyticsExemptionReason:
      'a solution is a component of an item; the authoring funnel is measured on item.* events',
  }),
  Object.freeze({
    eventType: 'MediaAssetPublished' as const,
    schemaVersion: 1,
    analyticsEvent: null,
    analyticsExemptionReason:
      'a media asset is a component of an item; the authoring funnel is measured on item.* events',
  }),
]);

/**
 * The registration for an event type, so a caller need not scan the registry.
 *
 * Returns `undefined` rather than falling back to some other entry: a caller
 * handed the wrong registration would emit an event under another event's
 * analytics name, which is worse than getting nothing back. The registry
 * covering every type is asserted directly in the spec.
 */
export function registrationFor(eventType: ContentEventType): EventRegistration | undefined {
  return CONTENT_EVENT_REGISTRY.find((entry) => entry.eventType === eventType);
}
