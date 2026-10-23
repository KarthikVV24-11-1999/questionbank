import { err, ok, type Result } from '../../domain/result.js';
import type { PublishedVersionReader } from '../../domain/repository-ports.js';
import type { ItemRepository } from '../../domain/repository-ports.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import { projectAnswerKey } from '../answer-key-projection.js';
import type { AnswerKeyData } from '../../../scoring/public/index.js';
import type { Handler } from '../handler-registry.js';
import type { ApplicationContext } from '../ports.js';
import { ROLES } from '../../../../platform/auth/roles.js';

/**
 * The one door through which an answer key leaves content for scoring (M6-40).
 *
 * **Seam-only, and the system's alone.** The handler has no route and no controller reaches it: it is built for the assessment
 * context's scoring consumer by `contentForAssessment`, and its policy admits `system` and nothing else — not a learner, not an
 * author, not content ops. The key crosses as `AnswerKeyData`, the executor's own input type from scoring's barrel, and as
 * nothing else: no stem, no option text, no solution.
 *
 * It reads **published versions only**, by version id: an attempt pins the versions it was sat on, and scoring marks against
 * exactly those, so a key edited or corrected later cannot reach back into an attempt already taken (INV-04).
 */
export interface GetAnswerKeysForScoring {
  readonly itemVersionIds: readonly string[];
}

export interface ScoringKeyView {
  readonly itemVersionId: string;
  readonly itemType: string;
  readonly answerKey: AnswerKeyData;
}

export const GET_ANSWER_KEYS_FOR_SCORING_POLICY = policy('GetAnswerKeysForScoring', [ROLES.system]);

export interface ScoringKeyDependencies {
  readonly versions: PublishedVersionReader;
  readonly items: ItemRepository;
}

export class GetAnswerKeysForScoringHandler implements Handler<GetAnswerKeysForScoring, readonly ScoringKeyView[]> {
  readonly name = 'GetAnswerKeysForScoring';
  readonly policy = GET_ANSWER_KEYS_FOR_SCORING_POLICY;

  constructor(private readonly deps: ScoringKeyDependencies) {}

  async handle(query: GetAnswerKeysForScoring, context: ApplicationContext): Promise<Result<readonly ScoringKeyView[], ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const views: ScoringKeyView[] = [];
    for (const itemVersionId of new Set(query.itemVersionIds)) {
      const owner = await this.deps.versions.itemOfPublishedVersion(itemVersionId);
      if (!owner.ok) return err(applicationError(owner.error.kind, owner.error.code, owner.error.message, owner.error.location));
      const item = await this.deps.items.findById(owner.value);
      if (!item.ok) return err(applicationError(item.error.kind, item.error.code, item.error.message, item.error.location));
      const version = item.value.versions.find((candidate) => candidate.versionId === itemVersionId);
      if (version === undefined) {
        return err(applicationError('NotFound', 'NOT_FOUND', `item version ${itemVersionId} is not published`, 'itemVersionId'));
      }
      const key = projectAnswerKey(version.responseSpec);
      if (!key.ok) return err(applicationError(key.error.kind, key.error.code, key.error.message, key.error.location));
      views.push(Object.freeze({ itemVersionId, itemType: version.itemType, answerKey: key.value }));
    }
    return ok(Object.freeze(views));
  }
}
