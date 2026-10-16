import type {
  AuthoredItemContent,
  DuplicateCandidatesResult,
  GetDuplicateCandidatesForProposal,
  ProposalFacts,
  ValidationReport,
} from '../../content/public/index.js';
import type { Result } from '../domain/result.js';
import type { ApplicationError } from '../application/authorization.js';
import type { ApplicationContext, ContentProposalChecks } from '../application/ports.js';
import type { CommandHandler } from './content-command-authoring.js';

export interface ContentProposalDependencies {
  /** Content's `validateProposedContent`, a pure function — injected, not imported, so generation holds no content code. */
  readonly validate: (content: AuthoredItemContent, facts: ProposalFacts) => ValidationReport;
  /** Content's `GetDuplicateCandidatesForProposal` handler. */
  readonly duplicates: CommandHandler<GetDuplicateCandidatesForProposal, DuplicateCandidatesResult>;
}

/**
 * The production `ContentProposalChecks` (M5-34): content's validator and
 * content's duplicate query, handed in by the composition root and called as
 * they are.
 *
 * It adds nothing and decides nothing. A finding is content's finding; a group
 * is content's group; a refusal — including content's own policy refusing the
 * caller — comes back unchanged.
 */
export class ContentProposalChecker implements ContentProposalChecks {
  readonly #deps: ContentProposalDependencies;

  constructor(deps: ContentProposalDependencies) {
    this.#deps = deps;
  }

  validate(content: AuthoredItemContent, facts: ProposalFacts): ValidationReport {
    return this.#deps.validate(content, facts);
  }

  duplicates(
    query: GetDuplicateCandidatesForProposal,
    context: ApplicationContext,
  ): Promise<Result<DuplicateCandidatesResult, ApplicationError>> {
    return this.#deps.duplicates.handle(query, context);
  }
}
