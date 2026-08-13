import { createClient, type ApiClient } from '@questionbank/contracts/client';
import {
  AuthoringItemPageSchema,
  AuthoringValidationReportSchema,
  type AuthoringItem,
  type ContentBody,
} from '@questionbank/contracts/content-schemas';
import type { ItemBrowserApi, ItemFilters, ItemRow, ValidationReport } from './item-browser-model.js';

/**
 * The live `ItemBrowserApi` (M0-19) — the client-side half of the walking
 * skeleton. Wires the item browser's list query through M0-17's typed client
 * to the composed API's one list endpoint, `GET /v1/authoring/drafts`.
 *
 * **This is narrower than the port it implements, and that is named rather
 * than hidden.** `ItemFilters` supports an arbitrary lifecycle state, a
 * subject and a concept — built (M3-43) against a listing endpoint this
 * milestone's API does not have. The one real endpoint is `ListMyDrafts`:
 * author-scoped, draft-state only. So this adapter always lists one author's
 * drafts and applies `lifecycleStates`/`subject` as a **client-side**
 * refinement over that result, never a second server call:
 *
 * - `subject` has no source at all on `AuthoringItemView` — content's domain
 *   attaches a concept, not a subject name, to a version's taxonomy tags, and
 *   resolving concept → subject is curriculum's cross-context lookup (D23,
 *   still open). The subject filter is therefore a no-op here — new debt
 *   **D33**, trigger: a curriculum concept → subject lookup lands, or content
 *   exposes one on the authoring query directly.
 * - `conceptIdentityId` likewise has no per-item source on this view and is a
 *   no-op here for the same reason.
 * - `label` is derived from the latest version's stem (first paragraph's
 *   text, truncated) — there is no separate title field.
 * - `publishedVersionNo` is resolved by matching `currentPublishedVersionId`
 *   against the item's own `versions`, never a second request.
 */

const LABEL_MAX_LENGTH = 80;

function plainTextOf(body: ContentBody): string {
  const firstBlock = (body.blocks as readonly Record<string, unknown>[])[0];
  const inlines = firstBlock?.['inlines'];
  if (!Array.isArray(inlines)) return '(untitled)';

  const text = inlines
    .map((inline) => (typeof inline === 'object' && inline !== null ? (inline as { value?: unknown }).value : undefined))
    .filter((value): value is string => typeof value === 'string')
    .join('');

  if (text.trim().length === 0) return '(untitled)';
  return text.length > LABEL_MAX_LENGTH ? `${text.slice(0, LABEL_MAX_LENGTH)}…` : text;
}

function toItemRow(item: AuthoringItem): ItemRow {
  const latestVersion = item.versions.at(-1);
  const publishedVersion = item.versions.find((version) => version.versionId === item.currentPublishedVersionId);

  return {
    itemId: item.itemId,
    label: latestVersion === undefined ? '(untitled)' : plainTextOf(latestVersion.stem),
    lifecycleState: item.lifecycleState,
    // Known gap, D33 — see the file header. Never fabricated.
    subject: '',
    authorPrincipalId: latestVersion?.authoredById ?? '',
    publishedVersionNo: publishedVersion?.versionNo ?? null,
  };
}

function matchesClientSideFilters(row: ItemRow, filters: ItemFilters): boolean {
  if (filters.lifecycleStates.length > 0 && !filters.lifecycleStates.includes(row.lifecycleState)) return false;
  return true;
}

export interface LiveItemBrowserApiConfig {
  readonly baseUrl: string;
  readonly getToken: () => string | null;
  readonly myPrincipalId: string;
  readonly client?: ApiClient;
}

export function createLiveItemBrowserApi(config: LiveItemBrowserApiConfig): ItemBrowserApi {
  const client = config.client ?? createClient({ baseUrl: config.baseUrl, getToken: config.getToken });

  return {
    async list(filters: ItemFilters): Promise<readonly ItemRow[]> {
      const authorId = filters.authorPrincipalId ?? config.myPrincipalId;
      const page = await client.request({
        path: '/v1/authoring/drafts',
        query: { authorId },
        responseSchema: AuthoringItemPageSchema,
      });
      return page.items.map(toItemRow).filter((row) => matchesClientSideFilters(row, filters));
    },

    async validationReport(itemId: string): Promise<ValidationReport> {
      return client.request({
        path: `/v1/authoring/items/${itemId}/validation-findings`,
        responseSchema: AuthoringValidationReportSchema,
      });
    },
  };
}
