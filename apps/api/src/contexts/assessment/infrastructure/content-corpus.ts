import type { AssemblyCandidate } from '../domain/assembly.js';
import type { BlueprintDifficultyBand, BlueprintItemType } from '../domain/blueprint.js';
import { preconditionFailedError, type AssessmentError } from '../domain/assessment-error.js';
import type { AnchorPoolRepository, ExposureLedger } from '../domain/repository-ports.js';
import { err, ok, type Result } from '../domain/result.js';

/**
 * Where assembly's corpus comes from: content's published catalogue, content's
 * own duplicate detection, the anchor pool and the exposure ledger — gathered
 * into the plain values the assembly domain takes.
 *
 * **Content's two handlers are injected, shaped as far as this adapter needs
 * them.** Content's barrel exports its queries as types and its handlers not
 * at all (ADR-0025), and the composition root hands assessment exactly the two
 * it is allowed (`contentForAssessment`). Declared here rather than imported so
 * that nothing in assessment names a content handler class.
 *
 * **Near-duplicate detection is content's, and is not reimplemented here.**
 * §6 says assembly uses §8's detection; a second implementation of "what counts
 * as a near-duplicate" is the drift this project has been bitten by three
 * times. What this adapter decides is only which of content's groups assembly
 * treats as disqualifying, below.
 */
export interface ContentContext {
  readonly principal: { readonly kind: 'human' | 'ai_agent' | 'system'; readonly id: string; readonly roleContext: readonly string[] };
  readonly correlationId: string;
}

interface ContentFailure {
  readonly kind: string;
  readonly code: string;
  readonly message: string;
}

type ContentResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ContentFailure };

export interface CatalogueEntry {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly itemType: BlueprintItemType;
  readonly difficultyBand: BlueprintDifficultyBand;
  readonly conceptIdentityIds: readonly string[];
  readonly stimulusVersionId?: string;
}

export interface CatalogueHandler {
  handle(
    query: { readonly subject?: string; readonly itemTypes?: readonly BlueprintItemType[]; readonly cursor?: string; readonly limit?: number },
    context: ContentContext,
  ): Promise<ContentResult<{ readonly entries: readonly CatalogueEntry[]; readonly nextCursor?: string }>>;
}

interface DuplicateMatch {
  readonly itemVersionId: string;
  readonly similarity?: number;
}

export interface DuplicatesHandler {
  handle(
    query: { readonly itemVersionId: string },
    context: ContentContext,
  ): Promise<
    ContentResult<{
      readonly state: 'evaluated' | 'not_evaluated';
      readonly exactMatches: readonly DuplicateMatch[];
      readonly skeletonMatches: readonly DuplicateMatch[];
      readonly trigramMatches: readonly DuplicateMatch[];
    }>
  >;
}

export interface ContentCorpusDependencies {
  readonly catalogue: CatalogueHandler;
  readonly duplicates: DuplicatesHandler;
  readonly anchors: AnchorPoolRepository;
  readonly exposure: ExposureLedger;
  /**
   * How similar content's "merely similar" matches must be before assembly
   * treats one as a near-duplicate. Exact and skeleton matches always are: they
   * are binary, and mean the same item retyped or with its constants swapped.
   * The ranked trigram group is advisory by content's own account, so this is a
   * threshold of assembly's choosing; 0.8 unless told otherwise.
   */
  readonly trigramThreshold?: number;
}

export interface LoadedCorpus {
  readonly candidates: readonly AssemblyCandidate[];
  readonly exposure: ReadonlyMap<string, number>;
  readonly nearDuplicates: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Published item versions left out because content has no fingerprint for
   * them, so it cannot say whether they duplicate anything (D55). They are
   * named, not dropped silently.
   */
  readonly unevaluated: readonly string[];
}

export type CorpusErrorCode = 'CORPUS_UNAVAILABLE';
export type CorpusError = AssessmentError<CorpusErrorCode>;

const DEFAULT_TRIGRAM_THRESHOLD = 0.8;
const PAGE = 200;

function unavailable(what: string, cause: string): CorpusError {
  return preconditionFailedError('CORPUS_UNAVAILABLE', `${what} could not be read: ${cause}`, what);
}

export class ContentCorpus {
  readonly #deps: ContentCorpusDependencies;

  constructor(deps: ContentCorpusDependencies) {
    this.#deps = deps;
  }

  async load(
    request: { readonly subject?: string; readonly itemTypes?: readonly BlueprintItemType[] },
    context: ContentContext,
  ): Promise<Result<LoadedCorpus, CorpusError>> {
    const entries: CatalogueEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#deps.catalogue.handle(
        {
          ...(request.subject === undefined ? {} : { subject: request.subject }),
          ...(request.itemTypes === undefined ? {} : { itemTypes: request.itemTypes }),
          ...(cursor === undefined ? {} : { cursor }),
          limit: PAGE,
        },
        context,
      );
      if (!page.ok) return err(unavailable('the published catalogue', page.error.code));
      entries.push(...page.value.entries);
      cursor = page.value.nextCursor;
    } while (cursor !== undefined);

    const members = await this.#deps.anchors.listActive();
    if (!members.ok) return err(unavailable('the anchor pool', members.error.code));
    const caps = new Map(members.value.map((member) => [member.itemVersionId, member.exposureCap]));

    const counts = await this.#deps.exposure.countsByItemVersion(entries.map((entry) => entry.itemVersionId));
    if (!counts.ok) return err(unavailable('the exposure ledger', counts.error.code));

    const threshold = this.#deps.trigramThreshold ?? DEFAULT_TRIGRAM_THRESHOLD;
    const candidates: AssemblyCandidate[] = [];
    const nearDuplicates = new Map<string, ReadonlySet<string>>();
    const unevaluated: string[] = [];

    for (const entry of entries) {
      const found = await this.#deps.duplicates.handle({ itemVersionId: entry.itemVersionId }, context);
      if (!found.ok) return err(unavailable('content\'s duplicate detection', found.error.code));
      if (found.value.state === 'not_evaluated') {
        unevaluated.push(entry.itemVersionId);
        continue;
      }
      nearDuplicates.set(
        entry.itemVersionId,
        new Set([
          ...found.value.exactMatches.map((match) => match.itemVersionId),
          ...found.value.skeletonMatches.map((match) => match.itemVersionId),
          ...found.value.trigramMatches.filter((match) => (match.similarity ?? 0) >= threshold).map((match) => match.itemVersionId),
        ]),
      );
      const cap = caps.get(entry.itemVersionId);
      candidates.push({
        itemId: entry.itemId,
        itemVersionId: entry.itemVersionId,
        itemType: entry.itemType,
        difficultyBand: entry.difficultyBand,
        conceptIdentityIds: entry.conceptIdentityIds,
        stimulusVersionId: entry.stimulusVersionId ?? null,
        isPublished: true,
        isAnchor: cap !== undefined,
        anchorExposureCap: cap ?? null,
      });
    }

    return ok(Object.freeze({ candidates, exposure: counts.value, nearDuplicates, unevaluated: Object.freeze(unevaluated) }));
  }
}
