import type { ContentBody } from '@questionbank/content-renderer';
import {
  bodyIsEmpty,
  notationAlternativeErrors,
  type BodyDraft,
  type FieldError,
} from '../../authoring/body-draft.js';

/**
 * The Stimulus editor's model (M3-41).
 *
 * **A stimulus is a first-class object, attached — never a passage pasted into
 * each item.** Pasting a passage five times creates five divergent passages
 * (UX §10.1), and DOMAIN-MODEL calls that the category's canonical fatal
 * error. So the surface offers *attach an existing one* first and *create a new
 * one* second, and the ordering is asserted rather than left to whoever edits
 * the layout next.
 */

export const STIMULUS_TYPES = ['passage', 'diagram', 'dataset', 'reaction_scheme'] as const;
export type StimulusType = (typeof STIMULUS_TYPES)[number];

export function isStimulusType(value: string): value is StimulusType {
  return (STIMULUS_TYPES as readonly string[]).includes(value);
}

export interface StimulusSummary {
  readonly stimulusId: string;
  readonly stimulusType: StimulusType;
  /** The opening of the passage, or the diagram's caption — enough to recognise it. */
  readonly label: string;
  readonly publishedVersionNo: number | null;
  readonly latestVersionNo: number;
}

export interface ReferencingItem {
  readonly itemId: string;
  readonly label: string;
}

export const STIMULUS_FORM_ERROR_CODES = [
  'STIMULUS_BODY_EMPTY',
  'NOTATION_ALTERNATIVE_MISSING',
] as const;
export type StimulusFormErrorCode = (typeof STIMULUS_FORM_ERROR_CODES)[number];

export interface StimulusDraft {
  readonly stimulusType: StimulusType;
  readonly body: BodyDraft;
}

/** Field-level problems only; the domain refuses the same drafts again. */
export function stimulusFormErrors(draft: StimulusDraft): readonly FieldError<StimulusFormErrorCode>[] {
  const errors: FieldError<StimulusFormErrorCode>[] = [];

  if (bodyIsEmpty(draft.body)) {
    errors.push({
      code: 'STIMULUS_BODY_EMPTY',
      message: 'The stimulus has no content.',
      location: 'body',
      fieldId: 'stimulus-block-0',
    });
  }
  errors.push(
    ...notationAlternativeErrors(draft.body, 'NOTATION_ALTERNATIVE_MISSING', 'body', 'stimulus'),
  );

  return errors;
}

export interface AttachResult {
  /**
   * Attachment pins the *version* current at attachment time (FR-TCH-03 rule
   * 2), so a passage edited later does not retroactively change what an item
   * asked. The handler resolves it; the surface reports which one it got.
   */
  readonly pinnedVersionNo: number;
}

export interface StimulusEditorApi {
  search(query: string): Promise<readonly StimulusSummary[]>;
  /** Which items already use this passage — shown before attaching, not after. */
  referencingItems(stimulusId: string): Promise<readonly ReferencingItem[]>;
  attachToItem(input: {
    readonly itemId: string;
    readonly stimulusId: string;
  }): Promise<AttachResult>;
  createDraft(input: {
    readonly stimulusType: StimulusType;
    readonly body: ContentBody;
  }): Promise<{ readonly stimulusId: string }>;
}
