import { err, ok, type Result } from '../../../domain/result.js';
import type { ContentError } from '../../../domain/content-error.js';
import type { ItemRepository, ReviewDecisionRepository } from '../../../domain/repository-ports.js';
import { addReviewerEditedVersion, type Item } from '../../../domain/item.js';
import { deriveReviewerEditedVersion } from '../../../domain/item-version.js';
import { createReviewDecision } from '../../../domain/review-decision.js';
import { assertDecisionEvidenceComplete } from '../../../domain/review/decision-evidence.js';
import { applicationError, authorize, type ApplicationError } from '../../authorization.js';
import type { ApplicationContext, AuditRecorder, Clock, IdentifierFactory, TransactionRunner } from '../../ports.js';
import { APPROVE_WITH_EDITS_POLICY } from '../policies.js';
import type { ApproveWithEdits } from '../commands/reviewer-edit-commands.js';

/**
 * Approve-with-edits (DEC-M4-3, ADR-0018, M4-29) — the reviewer edits, the
 * author stays the author, and no second reviewer is required for the
 * common case (ADR-0018's own line).
 *
 * **This handler drives no lifecycle transition.** `addReviewerEditedVersion`
 * (M4-29's own addition to `domain/item.ts`) attaches the edited version
 * while the item stays `in_review`; the decision this handler records
 * against that new version can never itself stand as the publication
 * signature (`publication-preconditions.ts`'s self-review check reads
 * `editedBy` too — INV-12, M4-04 — and this decision's reviewer *is* the
 * edited version's `editedBy`, always, by construction). Publication needs
 * a genuinely independent reviewer's decision against the edited version,
 * recorded the ordinary way through `RecordItemReviewDecisionHandler` —
 * which is exactly what leaves the item claimable again rather than this
 * handler forcing it to `approved` on a signature that could never publish
 * anything.
 *
 * **One transaction (the same shape M4-28 established):** the edited
 * version's attachment, the decision (with its candidate rows and the
 * assignment's transition to `decided`), all commit together or none does.
 */
export interface ReviewerEditDependencies {
  readonly items: ItemRepository;
  readonly reviews: ReviewDecisionRepository;
  readonly transactions: TransactionRunner;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
}

/**
 * `ReviewDecisionRepository`/`ItemRepository`'s errors are already
 * `ContentError`-shaped; the same one-line unpacking `lifecycle-handlers.ts`
 * and `assignment-handlers.ts` each already do. Not a second implementation
 * of a rule — there is no judgement here to drift — and
 * `application/review/**` cannot import either file's private helper
 * (DEC-M4-7's sub-boundary).
 */
function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

export class ApproveWithEditsHandler {
  readonly name = 'ApproveWithEdits';
  readonly policy = APPROVE_WITH_EDITS_POLICY;

  constructor(private readonly deps: ReviewerEditDependencies) {}

  async handle(command: ApproveWithEdits, context: ApplicationContext): Promise<Result<Item, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.items.findById(command.itemId);
    if (!found.ok) return err(fromContent(found.error));
    const item = found.value;

    const version = item.versions.find((candidate) => candidate.versionId === command.itemVersionId);
    if (version === undefined) {
      return err(
        applicationError(
          'NotFound',
          'VERSION_NOT_FOUND',
          `item ${command.itemId} holds no version ${command.itemVersionId}`,
          'itemVersionId',
        ),
      );
    }

    // The cheap refusal first (M4-28's discipline, reused): self-review
    // against the version being edited, and the candidates-shown
    // disclosure — checked before deriving anything or writing.
    const evidence = assertDecisionEvidenceComplete(
      {
        outcome: 'approve_with_edits',
        reviewer: context.principal,
        candidatesShownIds: command.candidatesShownIds,
      },
      {
        authoredBy: version.authoredBy,
        ...(version.editedBy === undefined ? {} : { editedBy: version.editedBy }),
      },
    );
    if (!evidence.ok) return err(fromContent(evidence.error));

    // M4-08's edit-scope bound (EDITABLE_UNDER_REVIEW/FORBIDDEN_UNDER_REVIEW)
    // is enforced inside `deriveReviewerEditedVersion` itself — a scope
    // violation or a key edit is refused here, with the offending field and
    // (for a key edit) the correct next outcome, both named by the domain.
    const edited = deriveReviewerEditedVersion(version, {
      versionId: this.deps.identifiers.next(),
      editedBy: context.principal,
      createdAt: this.deps.clock.now().toISOString(),
      edits: command.edits,
    });
    if (!edited.ok) return err(fromContent(edited.error));

    // ADR-0018's rules (authoredBy carries over, editedBy differs from it)
    // are re-enforced at the aggregate by `addReviewerEditedVersion` itself
    // — this call is not what makes them true, only where they are checked
    // structurally rather than trusted from the derivation above.
    const attached = addReviewerEditedVersion(item, edited.value);
    if (!attached.ok) return err(fromContent(attached.error));

    const decision = createReviewDecision({
      decisionId: this.deps.identifiers.next(),
      ownerType: 'item_version',
      ownerVersionId: edited.value.versionId,
      reviewer: context.principal,
      outcome: 'approve_with_edits',
      decidedAt: this.deps.clock.now().toISOString(),
      candidatesShownIds: command.candidatesShownIds,
    });
    if (!decision.ok) return err(fromContent(decision.error));

    const written = await this.deps.transactions.run(async (tx) => {
      const recorded = await this.deps.reviews.record(decision.value, command.assignmentId, tx);
      if (!recorded.ok) return recorded;
      return this.deps.items.save(attached.value, [], tx);
    });
    if (!written.ok) return err(fromContent(written.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'content',
      targetType: 'ItemVersion',
      targetId: edited.value.versionId,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });

    return ok(written.value);
  }
}
