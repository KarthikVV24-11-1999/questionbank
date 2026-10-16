import { createContentBody, type ContentBody } from './content-body.js';
import { createItemVersion, type CreateItemVersionProps, type ItemVersion } from './item-version.js';
import type { Finding } from './pre-submission-validation.js';
import { isRecord } from './shape.js';

/**
 * Building an item version out of a proposal that has not been stored, and
 * saying — as findings — everything the domain refuses about it.
 *
 * This is the structural half of validating a proposal, kept in the domain so
 * that both things that need it can reach it: the validator that reports on a
 * proposal (`application/proposal-validation.ts`) and the duplicate check that
 * fingerprints one (`application/review/queries/duplicate-queries.ts`), which
 * live on opposite sides of the review/authoring sub-boundary and may share only
 * what is in the domain.
 *
 * **Total (D41).** The input is a model's JSON and need not be the shape the
 * type says; whatever the constructors refuse comes back as a `STRUCTURE_INVALID`
 * finding, never a raised error. **Pure**: the instant provenance is judged at
 * is supplied, and nothing is stored.
 */

/** What a proposal states about an item — the fields of a version that an author, or a model, supplies. */
export type ProposedItemContent = Pick<
  CreateItemVersionProps,
  'stem' | 'responseSpec' | 'taxonomyTags' | 'difficultyEstimate' | 'provenance' | 'licensing' | 'stimulusVersionRef'
>;

export type ProposedItem =
  | { readonly ok: true; readonly version: ItemVersion }
  | { readonly ok: false; readonly findings: readonly Finding[] };

/** Whoever is validating is not authoring: this stands in for an author nothing here uses. */
const NOBODY = Object.freeze({ kind: 'system' as const, id: 'proposal-validation', roleContext: Object.freeze([] as string[]) });

/** Where a domain error says it happened. Every constructor sets it; an absent one reads as empty rather than as a branch nothing can reach. */
function whereOf(error: { readonly location?: string | undefined }): string {
  return [error.location].join('');
}

function structural(message: string, location: string): Finding {
  return Object.freeze({ code: 'STRUCTURE_INVALID', severity: 'blocking', message, location });
}

/** A content body from whatever was supplied in its place, or the finding that says why not. */
function bodyOf(value: unknown, location: string): { body?: ContentBody; finding?: Finding } {
  if (!isRecord(value)) return { finding: structural('there is no content body here, or it is not an object', location) };
  const built = createContentBody(value['blocks'] as never);
  return built.ok
    ? { body: built.value }
    : { finding: structural(`${built.error.code}: ${built.error.message}`, `${location}.${whereOf(built.error)}`) };
}

/** Every body carried by an option or matching member, by the location it sits at. */
function memberBodies(spec: Record<string, unknown>): { value: unknown; location: string }[] {
  const found: { value: unknown; location: string }[] = [];
  for (const side of ['options', 'left', 'right'] as const) {
    const members = spec[side];
    if (!Array.isArray(members)) continue;
    // Called only on a specification the constructors have accepted, so every member is an object.
    (members as Record<string, unknown>[]).forEach((member, index) => {
      found.push({ value: member['body'], location: `version.responseSpec.${side}[${index}].body` });
    });
  }
  return found;
}

export function buildProposedItem(content: ProposedItemContent, asOf: string): ProposedItem {
  const proposal = isRecord(content) ? (content as unknown as Record<string, unknown>) : {};
  const findings: Finding[] = [];

  const stem = bodyOf(proposal['stem'], 'version.stem');
  if (stem.finding !== undefined) findings.push(stem.finding);

  const spec = proposal['responseSpec'];
  const built = createItemVersion(
    {
      versionId: 'proposal',
      versionNo: 1,
      itemType: (isRecord(spec) ? spec['itemType'] : undefined) as never,
      stem: (stem.body ?? proposal['stem']) as never,
      responseSpec: spec as never,
      taxonomyTags: proposal['taxonomyTags'] as never,
      difficultyEstimate: proposal['difficultyEstimate'] as never,
      provenance: proposal['provenance'] as never,
      ...(proposal['licensing'] === undefined ? {} : { licensing: proposal['licensing'] as never }),
      ...(proposal['stimulusVersionRef'] === undefined ? {} : { stimulusVersionRef: proposal['stimulusVersionRef'] as never }),
      authoredBy: NOBODY,
      createdAt: asOf,
    },
    { latestPlausibleYear: Number(asOf.slice(0, 4)) },
  );
  if (!built.ok) {
    findings.push(structural(`${built.error.code}: ${built.error.message}`, whereOf(built.error)));
  } else {
    for (const member of memberBodies(built.value.responseSpec as unknown as Record<string, unknown>)) {
      const checked = bodyOf(member.value, member.location);
      if (checked.finding !== undefined) findings.push(checked.finding);
    }
  }

  if (findings.length > 0 || !built.ok) return { ok: false, findings };
  // The stem was checked above: a version only exists when it built, and a stem only builds when it is a body.
  return { ok: true, version: Object.freeze({ ...built.value, stem: stem.body as ContentBody }) };
}
