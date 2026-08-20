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
  'ReviewClaimed',
  'ReviewReleased',
  'ReviewDecided',
  'ItemReviewEscalated',
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

/**
 * DEC-M4-7 / §9 rule 4 — the review workspace lives inside content, so it
 * shares content's event vocabulary rather than declaring a second one; a
 * fourth context would have needed its own, which is exactly the
 * entanglement DEC-M4-7 avoids.
 *
 * A claim is queue plumbing, not content — carries the assignment, which
 * item version, the subject it routed on, and how it was assigned
 * (`assignmentType`, DEC-M4-9's `kind`). No reviewer identity beyond the
 * envelope's own `principal`, and nothing from `ItemVersion` itself.
 */
export interface ReviewClaimedPayload {
  readonly assignmentId: string;
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly subject: string;
  readonly assignmentType: string;
}

/**
 * `releaseType` distinguishes a reviewer stepping back (`released`) from a
 * lease timing out (`expired`, DEC-M4-1) — different failures, same shape.
 */
export interface ReviewReleasedPayload {
  readonly assignmentId: string;
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly releaseType: string;
}

/**
 * **Carries the outcome and the reason code — the two fields capacity
 * planning needs — and nothing more** (M4-12's own acceptance criterion).
 * Never `justification`: a reviewer's free-text justification is feedback to
 * one author, not an analytics field, and the outbox drains to analytics
 * (P4/D17) — exactly where it must never arrive. `duplicateOfItemId` is an
 * identifier, not the duplicate's content, so it is as safe here as
 * `itemId` is.
 */
export interface ReviewDecidedPayload {
  readonly decisionId: string;
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly outcomeType: string;
  readonly reasonCode?: string;
  readonly duplicateOfItemId?: string;
}

/**
 * DEC-M4-1 — escalation makes an item visible to Content Ops; it does not
 * reassign it, and `targetRoleType` names the role the item became visible
 * to (always `content_ops` today), never a principal.
 */
export interface ItemReviewEscalatedPayload {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly subject: string;
  readonly targetRoleType: string;
}

export type ItemPublished = DomainEvent<'ItemPublished', ItemPublishedPayload>;
export type ItemSuspended = DomainEvent<'ItemSuspended', ItemSuspendedPayload>;
export type ItemRetired = DomainEvent<'ItemRetired', ItemRetiredPayload>;
export type StimulusPublished = DomainEvent<'StimulusPublished', StimulusPublishedPayload>;
export type SolutionPublished = DomainEvent<'SolutionPublished', SolutionPublishedPayload>;
export type MediaAssetPublished = DomainEvent<'MediaAssetPublished', MediaAssetPublishedPayload>;
export type ReviewClaimed = DomainEvent<'ReviewClaimed', ReviewClaimedPayload>;
export type ReviewReleased = DomainEvent<'ReviewReleased', ReviewReleasedPayload>;
export type ReviewDecided = DomainEvent<'ReviewDecided', ReviewDecidedPayload>;
export type ItemReviewEscalated = DomainEvent<'ItemReviewEscalated', ItemReviewEscalatedPayload>;

export type ContentEvent =
  | ItemPublished
  | ItemSuspended
  | ItemRetired
  | StimulusPublished
  | SolutionPublished
  | MediaAssetPublished
  | ReviewClaimed
  | ReviewReleased
  | ReviewDecided
  | ItemReviewEscalated;

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
  Object.freeze({
    eventType: 'ReviewClaimed' as const,
    schemaVersion: 1,
    analyticsEvent: null,
    // Queue plumbing, not a funnel milestone. A per-claim analytics event is
    // also exactly the raw material a per-reviewer leaderboard would be built
    // from, which UX §11 and DEC-M4-13 forbid outright — capacity planning
    // reads the dedicated queue-health query (M4-33), never this event.
    analyticsExemptionReason:
      'a claim is queue plumbing; per-reviewer analytics here is the raw material of the ranking UX §11 forbids — capacity planning uses the dedicated queue-health query (M4-33)',
  }),
  Object.freeze({
    eventType: 'ReviewReleased' as const,
    schemaVersion: 1,
    analyticsEvent: null,
    analyticsExemptionReason:
      'a release — voluntary or a lease expiring (DEC-M4-1) — is a lock timing out or a reviewer stepping back, not a funnel signal',
  }),
  Object.freeze({
    eventType: 'ReviewDecided' as const,
    schemaVersion: 1,
    // EVENT-TAXONOMY §3's content pipeline already catalogues this exact
    // counterpart.
    analyticsEvent: 'item.review_decided',
    analyticsExemptionReason: null,
  }),
  Object.freeze({
    eventType: 'ItemReviewEscalated' as const,
    schemaVersion: 1,
    analyticsEvent: null,
    // DEC-M4-1: escalation is computed on read and exists to drive the
    // Content Ops queue surface (M4-33), not to feed analytics.
    analyticsExemptionReason:
      'escalation is computed on read (DEC-M4-1) and drives the Content Ops queue surface (M4-33), not an analytics funnel',
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
