import type { AttemptRepository, SolutionReleases } from '../../domain/repository-ports.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, fromAssessment, type ApplicationError } from '../authorization.js';
import type { GetSlotSolution } from '../commands/attempt-commands.js';
import type { Handler } from '../handler-registry.js';
import { GET_SLOT_SOLUTION_POLICY } from '../policies.js';
import type { ApplicationContext, SolutionBody, SolutionContent, SolutionSource, SolutionStepContent } from '../ports.js';
import { gate, ownAttempt } from './attempt-handlers.js';

/**
 * What a learner reads of a solution, after effort (M7-37). **Sections, in the order a learner should meet them**: why the attractive wrong answers are wrong,
 * then the method, then any other approach. The order is the content of the response, not an accident of field order, so a client cannot show the method first
 * by reading keys in another sequence.
 *
 * Built field by field from the content's delivery view. The structured final answer is not read here because content does not deliver it; the steps say the
 * answer in prose, which is what INV-08 grants. Hints (AI-ARCHITECTURE's three tiers) are a different thing and are not here.
 */
export interface SolutionStepView {
  readonly ordinal: number;
  readonly body: SolutionBody;
  readonly conceptRefs: readonly string[];
}

export type SolutionSection =
  | { readonly kind: 'why_wrong'; readonly analyses: readonly { readonly optionId: string; readonly explanation: SolutionBody }[] }
  | { readonly kind: 'method'; readonly steps: readonly SolutionStepView[] }
  | { readonly kind: 'alternate'; readonly label: string; readonly steps: readonly SolutionStepView[]; readonly applicabilityNote?: string };

export interface SlotSolutionView {
  readonly attemptId: string;
  readonly slotId: string;
  readonly itemVersionId: string;
  readonly solutionVersionId: string;
  readonly depth: 'basic' | 'full';
  readonly sections: readonly SolutionSection[];
}

export interface SlotSolutionDependencies {
  readonly attempts: Pick<AttemptRepository, 'findById'>;
  readonly releases: SolutionReleases;
  readonly solutions: SolutionSource;
}

const steps = (source: readonly SolutionStepContent[]): readonly SolutionStepView[] =>
  Object.freeze(source.map((step) => Object.freeze({ ordinal: step.ordinal, body: step.body, conceptRefs: Object.freeze([...step.conceptRefs]) })));

export function toSlotSolutionView(attemptId: string, slotId: string, itemVersionId: string, depth: 'basic' | 'full', content: SolutionContent): SlotSolutionView {
  const sections: SolutionSection[] = [];
  if (content.distractorAnalyses !== undefined && content.distractorAnalyses.length > 0) {
    sections.push(
      Object.freeze({
        kind: 'why_wrong' as const,
        analyses: Object.freeze(content.distractorAnalyses.map((entry) => Object.freeze({ optionId: entry.optionId, explanation: entry.misconception }))),
      }),
    );
  }
  sections.push(Object.freeze({ kind: 'method' as const, steps: steps(content.steps) }));
  for (const approach of content.alternateApproaches ?? []) {
    sections.push(
      Object.freeze({
        kind: 'alternate' as const,
        label: approach.label,
        steps: steps(approach.steps),
        ...(approach.applicabilityNote === undefined ? {} : { applicabilityNote: approach.applicabilityNote }),
      }),
    );
  }
  return Object.freeze({ attemptId, slotId, itemVersionId, solutionVersionId: content.solutionVersionId, depth, sections: Object.freeze(sections) });
}

/**
 * The solution for one slot of the learner's own attempt, behind the effort gate (FRS 277, M7-36).
 *
 * **The gate is the database's.** `releases.releasedSlot` answers from `assessment.solution_release`, a view over the stored events; nothing here counts
 * events, reads a mode or assembles a flag. What comes back is a `ReleasedSlot`, and the only thing that fetches a solution takes one. A slot that is not
 * released is refused as `SOLUTION_NOT_RELEASED` whether or not a solution exists, so the refusal cannot be used to find out which slots have one.
 */
export class GetSlotSolutionHandler implements Handler<GetSlotSolution, SlotSolutionView> {
  readonly name = 'GetSlotSolution';
  readonly policy = GET_SLOT_SOLUTION_POLICY;

  constructor(private readonly deps: SlotSolutionDependencies) {}

  async handle(query: GetSlotSolution, context: ApplicationContext): Promise<Result<SlotSolutionView, ApplicationError>> {
    const denied = gate(this.policy, context);
    if (denied !== null) return err(denied);
    const owned = await ownAttempt(this.deps, query.attemptId, context);
    if (!owned.ok) return owned;
    const attempt = owned.value;
    if (!attempt.slots.some((slot) => slot.slotId === query.slotId)) {
      return err(applicationError('NotFound', 'NOT_FOUND', `no slot ${query.slotId} in this attempt`, 'slotId'));
    }

    const released = await this.deps.releases.releasedSlot(attempt.attemptId, query.slotId);
    if (!released.ok) return err(fromAssessment(released.error));
    if (released.value === undefined) {
      return err(
        applicationError('PreconditionFailed', 'SOLUTION_NOT_RELEASED', 'a solution opens once you have answered the question or skipped it, and for a mock once it is submitted', 'slotId'),
      );
    }

    const content = await this.deps.solutions.solutionFor(released.value, query.depth, context);
    if (!content.ok) return content;
    return ok(toSlotSolutionView(attempt.attemptId, query.slotId, released.value.itemVersionId, query.depth, content.value));
  }
}
