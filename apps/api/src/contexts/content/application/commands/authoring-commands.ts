import type { ContentBody } from '../../domain/content-body.js';
import type { DifficultyBand } from '../../domain/item-version.js';
import type { CreateLicensingStatusProps } from '../../domain/licensing-status.js';
import type { CreateProvenanceProps } from '../../domain/provenance.js';
import type { CreateResponseSpecificationProps, ItemType } from '../../domain/response-specification.js';
import type { CreateTaxonomyTagProps } from '../../domain/taxonomy-tag.js';

/**
 * Imperative verb phrases (§2). One command per consequential act.
 *
 * A command carries what the **author** wrote and nothing the system knows for
 * itself: no version identifier, no `createdAt`, no `authoredBy`. Those are
 * supplied by the handler from its ports, so a caller cannot backdate a
 * version, forge an author, or choose an identifier that collides with one the
 * database already holds.
 */

/** Everything an author states about an item version. */
export interface AuthoredItemContent {
  readonly stem: ContentBody;
  readonly responseSpec: CreateResponseSpecificationProps;
  readonly taxonomyTags: readonly CreateTaxonomyTagProps[];
  readonly difficultyEstimate: DifficultyBand;
  readonly provenance: CreateProvenanceProps;
  /** Absent means `unresolved`, which blocks publication (FR-QM-05 rule 4). */
  readonly licensing?: CreateLicensingStatusProps;
  /** Pins a stimulus *version* (FR-TCH-03 rule 2). */
  readonly stimulusVersionRef?: string;
}

export interface CreateItemDraft {
  readonly itemType: ItemType;
  readonly content: AuthoredItemContent;
  /**
   * Declared only when it cannot be derived from the principal's own scope
   * (M4-14) — absent for the common case of a single-subject-scoped author,
   * where `resolveAuthoringSubject` derives it and refuses a declaration
   * that disagrees.
   */
  readonly subject?: string;
}

/**
 * Autosave (FR-TCH-02 rule 6). Edits the draft version in place rather than
 * appending one: a version per keystroke burst would make version history
 * unreadable and would give a reviewer nothing to diff against.
 *
 * `idempotencyKey` makes a retried save a no-op. A *new* version comes from
 * `DeriveDraftFromVersion`, which is what FR-TCH-09 rule 1 asks for after
 * review returns the item.
 */
export interface UpdateItemDraft {
  readonly itemId: string;
  readonly content: AuthoredItemContent;
  readonly idempotencyKey: string;
}

export interface DeriveDraftFromVersion {
  readonly itemId: string;
  readonly fromVersionId: string;
}

/** Permanent, and audited because it is permanent (FR-TCH-06 rule 3). */
export interface DeleteItemDraft {
  readonly itemId: string;
  readonly justification: string;
}
