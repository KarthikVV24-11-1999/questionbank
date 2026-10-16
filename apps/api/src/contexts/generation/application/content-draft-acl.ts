import type { AuthoredItemContent, CreateItemDraft, ItemType } from '../../content/public/index.js';
import { err, ok, type Result } from '../domain/result.js';
import { preconditionFailedError, validationError, type GenerationError } from '../domain/generation-error.js';
import type { GenerationCandidate } from '../domain/generation-candidate.js';
import type { ModelPinField } from '../domain/model-pin.js';
import { isUuid } from '../domain/uuid.js';

/**
 * The anti-corruption layer from an accepted candidate to a content draft
 * (ADR-0025). Generation proposes; this module shapes the proposal into the one
 * command a human author's draft goes through, and content's own handler
 * performs every write under content's own invariants.
 *
 * **Why this lives in `application/` and not `domain/`.** `domain/` imports
 * nothing — not another context, not even through a barrel (F2). The mapping
 * has to name content's command types, so it sits one layer out, the same
 * place `content/application/answer-key-projection.ts` sits for the same
 * reason.
 *
 * **The names differ on purpose, and that is the hazard.** Generation's `runId`
 * is content's `generationRunId`. Two representations of one fact drift
 * silently, so the rename is declared once, below, typed against both sides —
 * a pin member without a mapping, or a mapping onto a field content does not
 * have, is a compile error — and the spec asserts the result field by field.
 *
 * Two differences between the sides are handled here and not left to content: it
 * stores the pin as UUIDs, which this refuses a label for, and it keeps confidence
 * to three decimals, which this rounds to. Neither is visible from content's types.
 *
 * **A candidate content's provenance would refuse is refused here**, naming the
 * field, rather than arriving as a content error the operator cannot act on:
 * the operator is looking at a candidate, not at a content command.
 */

/** Content's AI provenance, as its own command types it — never restated. */
export type ProvenanceFields = AuthoredItemContent['provenance'];

/** Where each member of the pin lands in content's provenance. */
export const PIN_TO_PROVENANCE = {
  modelVersionId: 'modelVersionId',
  promptVersionId: 'promptVersionId',
  runId: 'generationRunId',
} as const satisfies Record<ModelPinField, keyof ProvenanceFields>;

/**
 * What a proposal's body must carry for content to author an item from it. The
 * body is an opaque document to generation's domain; this is the application
 * layer's reading of it. Presence only: whether the stem is a valid content
 * body, or the specification scorable, is content's to decide and content's
 * errors say so.
 *
 * `subject` is required because the accepting principal is Content Ops, whose
 * authoring is not scoped to one subject (FR-TCH-01 rule 1) — content would
 * refuse a draft that did not name one, and the operator cannot edit a body.
 */
export const PROPOSAL_REQUIRED_KEYS = ['stem', 'responseSpec', 'taxonomyTags', 'difficultyEstimate', 'subject'] as const;

export type AclErrorCode =
  | 'PROVENANCE_FIELD_BLANK'
  | 'PROVENANCE_FIELD_NOT_A_UUID'
  | 'PROVENANCE_CONFIDENCE_MISSING'
  | 'PROVENANCE_CONFIDENCE_OUT_OF_RANGE'
  | 'PROPOSAL_FIELD_MISSING';

export type AclError = GenerationError<AclErrorCode>;

/**
 * Content stores confidence as `numeric(4, 3)`, so it keeps three decimal
 * places and silently rounds the rest. Rounding it here instead means the value
 * sent is the value stored, and the draft's provenance reads back as the
 * mapping said it would; the candidate keeps the full-precision figure.
 */
function toContentPrecision(confidence: number): number {
  return Math.round(confidence * 1000) / 1000;
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

/**
 * The four things content's `createProvenance` demands of `ai_generated`, from
 * the candidate's own fields. Re-checked here rather than trusted: a candidate
 * rehydrated from storage never went through construction.
 */
export function toAiProvenance(candidate: GenerationCandidate): Result<ProvenanceFields, AclError> {
  for (const [member, field] of Object.entries(PIN_TO_PROVENANCE) as [ModelPinField, keyof ProvenanceFields][]) {
    if (isBlank(candidate.pin[member])) {
      return err(
        preconditionFailedError(
          'PROVENANCE_FIELD_BLANK',
          `content would refuse this candidate's AI provenance: ${field} is blank (the candidate's pin.${member})`,
          `provenance.${field}`,
        ),
      );
    }
    // Content keeps all three as UUIDs, and a model or prompt version that is a
    // label rather than an identifier is stored nowhere: generation's own schema
    // takes either, so this is where the difference is caught.
    if (!isUuid(candidate.pin[member])) {
      return err(
        preconditionFailedError(
          'PROVENANCE_FIELD_NOT_A_UUID',
          `content would refuse this candidate's AI provenance: ${field} must be a UUID, got "${candidate.pin[member]}" (the candidate's pin.${member})`,
          `provenance.${field}`,
        ),
      );
    }
  }

  const { confidence } = candidate;
  if (typeof confidence !== 'number') {
    return err(
      preconditionFailedError(
        'PROVENANCE_CONFIDENCE_MISSING',
        "content would refuse this candidate's AI provenance: it carries no confidence",
        'provenance.confidence',
      ),
    );
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return err(
      preconditionFailedError(
        'PROVENANCE_CONFIDENCE_OUT_OF_RANGE',
        `content would refuse this candidate's AI provenance: confidence must lie in [0, 1], got ${confidence}`,
        'provenance.confidence',
      ),
    );
  }

  return ok({
    sourceType: 'ai_generated',
    [PIN_TO_PROVENANCE.modelVersionId]: candidate.pin.modelVersionId,
    [PIN_TO_PROVENANCE.promptVersionId]: candidate.pin.promptVersionId,
    [PIN_TO_PROVENANCE.runId]: candidate.pin.runId,
    confidence: toContentPrecision(confidence),
  } as ProvenanceFields);
}

/**
 * The proposal's shape, judged once and used twice: when a proposal is made, so
 * a candidate that could never become a draft is refused before it exists, and
 * when it is accepted, which also covers a candidate stored before the rule
 * tightened. Presence of the keys content needs, and a subject that says
 * something — nothing about whether any of it is valid *content*.
 */
export function checkProposalBody(body: Readonly<Record<string, unknown>>): Result<true, GenerationError> {
  for (const key of PROPOSAL_REQUIRED_KEYS) {
    if (body[key] === undefined) {
      return err(
        validationError('PROPOSAL_FIELD_MISSING', `the proposal does not carry "${key}", which content needs to author an item`, `content.body.${key}`),
      );
    }
  }
  if (isBlank(body['subject'])) {
    return err(validationError('PROPOSAL_FIELD_MISSING', 'the proposal names no subject', 'content.body.subject'));
  }
  return ok(true);
}

/** The command that puts the candidate in front of a human author's queue as a draft. */
export function toContentDraft(candidate: GenerationCandidate): Result<CreateItemDraft, AclError | GenerationError> {
  const provenance = toAiProvenance(candidate);
  if (!provenance.ok) return provenance;

  const body = candidate.content.body;
  const shaped = checkProposalBody(body);
  if (!shaped.ok) return shaped;

  const content: AuthoredItemContent = {
    stem: body['stem'] as AuthoredItemContent['stem'],
    responseSpec: body['responseSpec'] as AuthoredItemContent['responseSpec'],
    taxonomyTags: body['taxonomyTags'] as AuthoredItemContent['taxonomyTags'],
    difficultyEstimate: body['difficultyEstimate'] as AuthoredItemContent['difficultyEstimate'],
    provenance: provenance.value,
    ...(body['licensing'] === undefined ? {} : { licensing: body['licensing'] as NonNullable<AuthoredItemContent['licensing']> }),
    ...(body['stimulusVersionRef'] === undefined
      ? {}
      : { stimulusVersionRef: body['stimulusVersionRef'] as string }),
  };

  return ok({
    itemType: candidate.content.itemType as ItemType,
    subject: body['subject'] as string,
    content,
  });
}
