import { err, ok, type Result } from '../../domain/result.js';
import type { ContentError } from '../../domain/content-error.js';
import type {
  ItemRepository,
  SolutionRepository,
  StimulusRepository,
} from '../../domain/repository-ports.js';
import type { ContentBody } from '../../domain/content-body.js';
import { publishedVersionOf } from '../../domain/item.js';
import type { ItemVersion } from '../../domain/item-version.js';
import type { AnswerForm } from '../../domain/response-specification.js';
import type { SolutionVersion } from '../../domain/solution.js';
import { publishedStimulusVersionOf, type StimulusType, type StimulusVersion } from '../../domain/stimulus.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import type { ApplicationContext, Entitlements } from '../ports.js';

/**
 * The delivery read models. **No view here carries an answer key, a
 * correct-option marker, a numeric expected value or an `is_correct` flag**
 * (§9 rule 10, ADR-0009), on any code path and for any role.
 *
 * That is why these views are built field by field rather than by spreading a
 * domain object and deleting what should not be there: a spread carries every
 * field the source gains next year, and the field it would carry first is the
 * one somebody adds next to `correctOptionId`.
 *
 * **The matching pairing is absent for the same reason as the option marker.**
 * A pairing *is* the key; showing the members without it is the whole point.
 *
 * **The numeric expected value, tolerance and range are absent**; only what an
 * input box needs to label itself — the canonical unit and the accepted forms
 * — crosses.
 */

/** Every role that reads published content, including the unauthenticated tier. */
export const DELIVERY_ROLES = Object.freeze([
  'learner',
  'guest',
  'author',
  'reviewer',
  'content_ops',
  'system',
]);

export const GET_PUBLISHED_ITEM_POLICY = policy('GetPublishedItem', DELIVERY_ROLES);
export const GET_PUBLISHED_STIMULUS_POLICY = policy('GetPublishedStimulus', DELIVERY_ROLES);
export const GET_PUBLISHED_SOLUTION_POLICY = policy('GetPublishedSolution', DELIVERY_ROLES);

export interface GetPublishedItem {
  readonly itemId: string;
}

export interface GetPublishedStimulus {
  readonly stimulusId: string;
}

export interface GetPublishedSolution {
  readonly itemVersionId: string;
  /**
   * `basic` is the correct answer and the derivation, which INV-08 grants
   * unconditionally. `full` adds distractor analysis and alternate
   * approaches, which DECISIONS §C's tier table puts behind a plan.
   */
  readonly depth: 'basic' | 'full';
}

export interface DeliveryOptionView {
  readonly optionId: string;
  readonly ordinal: number;
  readonly body: ContentBody;
}

export interface DeliveryMatchingMemberView {
  readonly memberId: string;
  readonly ordinal: number;
  readonly body: ContentBody;
}

/** What an input box needs, and nothing the marker needs. */
export interface DeliveryNumericInputView {
  readonly unitCanonical?: string;
  readonly unitRequired: boolean;
  readonly acceptedForms: readonly AnswerForm[];
}

export interface DeliveryItemView {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly versionNo: number;
  readonly itemType: ItemVersion['itemType'];
  readonly stem: ContentBody;
  readonly stimulusVersionId?: string;
  readonly options?: readonly DeliveryOptionView[];
  readonly matchingLeft?: readonly DeliveryMatchingMemberView[];
  readonly matchingRight?: readonly DeliveryMatchingMemberView[];
  readonly numericInput?: DeliveryNumericInputView;
}

export interface DeliveryStimulusView {
  readonly stimulusId: string;
  readonly stimulusVersionId: string;
  readonly versionNo: number;
  readonly stimulusType: StimulusType;
  readonly body: ContentBody;
}

export interface DeliverySolutionStepView {
  readonly ordinal: number;
  readonly body: ContentBody;
  readonly conceptRefs: readonly string[];
}

export interface DeliveryAlternateApproachView {
  readonly label: string;
  readonly steps: readonly DeliverySolutionStepView[];
  readonly applicabilityNote?: string;
}

export interface DeliverySolutionView {
  readonly solutionVersionId: string;
  readonly targetItemVersionId: string;
  /**
   * The derivation. **`finalAnswerAssertion` is deliberately absent**: as a
   * structured field it is a correct-option marker or an expected value, which
   * is the key by another name. The steps state the answer in prose, which is
   * what INV-08 grants and what a learner reads anyway.
   */
  readonly steps: readonly DeliverySolutionStepView[];
  readonly distractorAnalyses?: readonly { readonly optionId: string; readonly misconception: ContentBody }[];
  readonly alternateApproaches?: readonly DeliveryAlternateApproachView[];
}

function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

function toStepViews(steps: SolutionVersion['steps']): readonly DeliverySolutionStepView[] {
  return Object.freeze(
    steps.map((step) =>
      Object.freeze({
        ordinal: step.ordinal,
        body: step.body,
        conceptRefs: Object.freeze([...step.conceptRefs]),
      }),
    ),
  );
}

export function toDeliveryItemView(itemId: string, version: ItemVersion): DeliveryItemView {
  const base = {
    itemId,
    itemVersionId: version.versionId,
    versionNo: version.versionNo,
    itemType: version.itemType,
    stem: version.stem,
    ...(version.stimulusVersionRef === undefined
      ? {}
      : { stimulusVersionId: version.stimulusVersionRef }),
  };

  const spec = version.responseSpec;
  switch (spec.itemType) {
    case 'SINGLE_CORRECT_MCQ':
    case 'MULTIPLE_CORRECT_MCQ':
      return Object.freeze({
        ...base,
        options: Object.freeze(
          spec.options.map((option) =>
            // Named field by field. `correctOptionId` and `correctOptionIds`
            // are not read here at all, so no future spread can carry them.
            Object.freeze({ optionId: option.optionId, ordinal: option.ordinal, body: option.body }),
          ),
        ),
      });

    case 'MATCHING': {
      const members = (side: typeof spec.left): readonly DeliveryMatchingMemberView[] =>
        Object.freeze(
          side.map((member) =>
            Object.freeze({ memberId: member.memberId, ordinal: member.ordinal, body: member.body }),
          ),
        );
      // `spec.pairs` is the key. It is not read.
      return Object.freeze({ ...base, matchingLeft: members(spec.left), matchingRight: members(spec.right) });
    }

    case 'NUMERIC':
      return Object.freeze({
        ...base,
        numericInput: Object.freeze({
          ...(spec.spec.unit?.canonical === undefined ? {} : { unitCanonical: spec.spec.unit.canonical }),
          unitRequired: spec.spec.unit?.required ?? false,
          acceptedForms: Object.freeze([...spec.spec.acceptedForms]),
        }),
      });
  }
}

export function toDeliveryStimulusView(
  stimulusId: string,
  stimulusType: StimulusType,
  version: StimulusVersion,
): DeliveryStimulusView {
  return Object.freeze({
    stimulusId,
    stimulusVersionId: version.versionId,
    versionNo: version.versionNo,
    stimulusType,
    body: version.body,
  });
}

export function toDeliverySolutionView(
  version: SolutionVersion,
  targetItemVersionId: string,
  depth: 'basic' | 'full',
): DeliverySolutionView {
  const basic = {
    solutionVersionId: version.versionId,
    targetItemVersionId,
    steps: toStepViews(version.steps),
  };
  if (depth === 'basic') return Object.freeze(basic);

  return Object.freeze({
    ...basic,
    distractorAnalyses: Object.freeze(
      version.distractorAnalyses.map((analysis) =>
        Object.freeze({ optionId: analysis.optionId, misconception: analysis.misconception }),
      ),
    ),
    alternateApproaches: Object.freeze(
      version.alternateApproaches.map((approach) =>
        Object.freeze({
          label: approach.label,
          steps: toStepViews(approach.steps),
          ...(approach.applicabilityNote === undefined
            ? {}
            : { applicabilityNote: approach.applicabilityNote }),
        }),
      ),
    ),
  });
}

export interface DeliveryQueryDependencies {
  readonly items: ItemRepository;
  readonly stimuli: StimulusRepository;
  readonly solutions: SolutionRepository;
  readonly entitlements: Entitlements;
}

export class GetPublishedItemHandler implements Handler<GetPublishedItem, DeliveryItemView> {
  readonly name = 'GetPublishedItem';
  readonly policy = GET_PUBLISHED_ITEM_POLICY;

  constructor(private readonly deps: DeliveryQueryDependencies) {}

  async handle(
    query: GetPublishedItem,
    context: ApplicationContext,
  ): Promise<Result<DeliveryItemView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const item = await this.deps.items.findById(query.itemId);
    if (!item.ok) return err(fromContent(item.error));

    // **`published`, not "has a published version".** A suspended item still
    // names the version it published, because history is retained (FR-QM-01
    // rule 5) — and it is exactly that retained pointer that would keep
    // serving content somebody withdrew from students. The version is read off
    // the aggregate already loaded rather than fetched again, so there is no
    // second answer to disagree with the first.
    const version =
      item.value.lifecycleState === 'published' ? publishedVersionOf(item.value) : undefined;
    if (version === undefined) {
      return err(
        applicationError('NotFound', 'NOT_FOUND', `item ${query.itemId} is not published`, 'itemId'),
      );
    }

    return ok(toDeliveryItemView(query.itemId, version));
  }
}

export class GetPublishedStimulusHandler implements Handler<GetPublishedStimulus, DeliveryStimulusView> {
  readonly name = 'GetPublishedStimulus';
  readonly policy = GET_PUBLISHED_STIMULUS_POLICY;

  constructor(private readonly deps: DeliveryQueryDependencies) {}

  async handle(
    query: GetPublishedStimulus,
    context: ApplicationContext,
  ): Promise<Result<DeliveryStimulusView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const stimulus = await this.deps.stimuli.findById(query.stimulusId);
    if (!stimulus.ok) return err(fromContent(stimulus.error));

    const version =
      stimulus.value.lifecycleState === 'published'
        ? publishedStimulusVersionOf(stimulus.value)
        : undefined;
    if (version === undefined) {
      return err(
        applicationError('NotFound', 'NOT_FOUND', `stimulus ${query.stimulusId} is not published`, 'stimulusId'),
      );
    }

    return ok(toDeliveryStimulusView(query.stimulusId, stimulus.value.stimulusType, version));
  }
}

export class GetPublishedSolutionHandler implements Handler<GetPublishedSolution, DeliverySolutionView> {
  readonly name = 'GetPublishedSolution';
  readonly policy = GET_PUBLISHED_SOLUTION_POLICY;

  constructor(private readonly deps: DeliveryQueryDependencies) {}

  async handle(
    query: GetPublishedSolution,
    context: ApplicationContext,
  ): Promise<Result<DeliverySolutionView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    // **Entitlement is checked separately from authorization** (§8): "you are
    // not permitted" and "upgrade to see this" need different UX and different
    // metrics, and conflating them is how a product tells a paying customer
    // they are forbidden.
    //
    // The check runs only for `full`. Basic correctness is an unconditional
    // grant (INV-08) and is never asked about — an entitlement service that is
    // down cannot withhold it.
    if (query.depth === 'full') {
      const entitled = await this.deps.entitlements.allows(context.principal, 'SOLUTION_DEPTH_FULL');
      if (!entitled) {
        return err(
          applicationError(
            'Entitlement',
            'SOLUTION_DEPTH_NOT_ENTITLED',
            'distractor analysis and alternate approaches are part of a paid plan; the correct answer and the derivation are not',
            'depth',
          ),
        );
      }
    }

    const version = await this.deps.solutions.findPublishedForItemVersion(query.itemVersionId);
    if (!version.ok) return err(fromContent(version.error));

    return ok(toDeliverySolutionView(version.value, query.itemVersionId, query.depth));
  }
}
