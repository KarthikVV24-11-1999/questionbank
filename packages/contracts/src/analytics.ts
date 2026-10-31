import { z } from 'zod';

export { findPii, isPersonalKey, type PiiFinding, type PiiKind } from './analytics-pii.js';

/**
 * The analytics event envelope (docs/EVENT-TAXONOMY.md §1) and the catalog of names it admits (§3), shared by the ingestion edge and by the apps that emit.
 *
 * The names below are the document's §3, expanded. `event-catalog.spec.ts` in the API parses the document and requires the two to be the same set, so a name
 * added to one and not the other is a red build.
 */
export const EVENT_NAMES = [
  'account.registered',
  'account.verified',
  'onboarding.step_completed',
  'onboarding.abandoned',
  'onboarding.scope_declared',
  'diagnostic.started',
  'diagnostic.completed',
  'diagnostic.abandoned',
  'concept_map.viewed',
  'practice.session_started',
  'practice.item_answered',
  'practice.session_completed',
  'practice.session_abandoned',
  'solution.viewed',
  'remediation.set_generated',
  'remediation.set_completed',
  'mastery.gain_verified',
  'mastery.regressed',
  'review.due_completed',
  'review.due_skipped',
  'error_notebook.entry_reviewed',
  'mock.catalog_viewed',
  'mock.package_download_started',
  'mock.package_download_completed',
  'mock.package_download_failed',
  'mock.attempt_started',
  'mock.item_visited',
  'mock.item_answered',
  'mock.item_flagged',
  'mock.item_unflagged',
  'mock.section_entered',
  'mock.connectivity_lost',
  'mock.connectivity_restored',
  'mock.attempt_submitted',
  'mock.attempt_interrupted',
  'mock.attempt_recovered',
  'mock.result_viewed',
  'mock.diagnostic_viewed',
  'mock.remediation_clicked',
  'item.drafted',
  'item.submitted_for_review',
  'item.review_decided',
  'item.published',
  'item.retired',
  'item.suspended',
  'item.defect_reported',
  'item.defect_resolved',
  'solution.published',
  'taxonomy.version_published',
  'taxonomy.migration_executed',
  'ai.generation_run_started',
  'ai.generation_run_completed',
  'ai.precheck_evaluated',
  'ai.candidate_dispositioned',
  'ai.budget_threshold_crossed',
  'ai.degraded',
  'ai.tutor_turn',
  'paywall.shown',
  'paywall.dismissed',
  'plan.selected',
  'checkout.started',
  'checkout.completed',
  'checkout.failed',
  'subscription.renewed',
  'subscription.cancelled',
  'subscription.expired',
  'subscription.grace_entered',
  'quota.exhausted',
  'notification.sent',
  'notification.opened',
  'notification.suppressed',
  'search.executed',
  'search.result_selected',
  'moderation.report_filed',
  'moderation.action_taken',
  'client.error',
  'client.sync_failed',
  'performance.render_measured',
  'accessibility.assistive_tech_detected',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const ACTOR_KINDS = ['human', 'ai_agent', 'system'] as const;
export const DEVICE_SURFACES = ['web', 'pwa', 'android', 'ios'] as const;
/** A server and a worker have no device and no network of their own, so their events carry no class of either (§1). */
export const NON_DEVICE_SURFACES = ['server', 'worker'] as const;
export const SURFACES = [...DEVICE_SURFACES, ...NON_DEVICE_SURFACES] as const;
export type DeviceSurface = (typeof DEVICE_SURFACES)[number];
export const DEVICE_CLASSES = ['low', 'mid', 'high'] as const;
export const NETWORK_CLASSES = ['offline', '2g', '3g', '4g', 'wifi'] as const;

/** An identifier, never prose: no whitespace and no `@`, so a name or an address does not fit where a pseudonymous id goes. */
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]));

const contextSchema = z
  .object({
    exam_id: z.string().min(1).optional(),
    attempt_id: z.string().min(1).optional(),
    item_version_id: z.string().min(1).optional(),
    concept_identity_id: z.string().min(1).optional(),
    form_id: z.string().min(1).optional(),
  })
  .strict();

const envelopeBase = {
  event_id: z.string().regex(UUID_V7),
  event_name: z.enum(EVENT_NAMES),
  event_version: z.number().int().min(1),
  occurred_at: z.iso.datetime({ offset: true }),
  actor: z.object({ kind: z.enum(ACTOR_KINDS), pseudonymous_id: z.string().regex(OPAQUE) }).strict(),
  session_id: z.string().regex(OPAQUE),
  app_version: z.string().regex(OPAQUE),
  tenant_id: z.string().regex(OPAQUE),
  context: contextSchema,
  payload: z.record(z.string(), jsonValue),
};

/** From a device: both classes are required, because a missing one is a segment nobody can place the event in. */
const deviceEnvelope = z.object({ ...envelopeBase, surface: z.enum(DEVICE_SURFACES), device_class: z.enum(DEVICE_CLASSES), network_class: z.enum(NETWORK_CLASSES) }).strict();
/** From a server or a worker: neither class exists, so neither may be carried. A nominal value would count every such event as a device on a network. */
const serverEnvelope = z.object({ ...envelopeBase, surface: z.enum(NON_DEVICE_SURFACES) }).strict();

/** What an emitter builds. `received_at` is the edge's to stamp: it is the moment of ingestion, and an emitter cannot know it. */
export const clientEnvelopeSchema = z.discriminatedUnion('surface', [deviceEnvelope, serverEnvelope]);
export type DeviceEnvelope = z.infer<typeof deviceEnvelope>;
export type ServerEnvelope = z.infer<typeof serverEnvelope>;
export type ClientEnvelope = z.infer<typeof clientEnvelopeSchema>;

export type AnalyticsEnvelope = ClientEnvelope & { readonly received_at: string };

/** Every envelope field the document lists, for a test that holds the schema to it. */
export const ENVELOPE_FIELDS = ['event_id', 'event_name', 'event_version', 'occurred_at', 'received_at', 'actor', 'session_id', 'surface', 'app_version', 'device_class', 'network_class', 'tenant_id', 'context'] as const;

const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * A UUIDv7: forty-eight bits of Unix milliseconds, then version and variant, then random. Pure: the instant and the random bytes are the caller's, so an emitter that wants
 * the same id for the same fact on every delivery derives the bytes from the fact. At least ten bytes are read.
 */
export function uuidV7(unixMs: number, random: Uint8Array): string {
  if (!Number.isSafeInteger(unixMs) || unixMs < 0 || unixMs >= 2 ** 48) throw new RangeError('a UUIDv7 holds a 48-bit millisecond instant');
  if (random.length < 10) throw new RangeError('a UUIDv7 needs ten random bytes');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(unixMs / 2 ** (8 * (5 - i))) % 256;
  bytes.set(random.subarray(0, 10), 6);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const text = hex(bytes);
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
