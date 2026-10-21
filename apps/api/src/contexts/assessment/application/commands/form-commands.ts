import type { Blueprint } from '../../domain/blueprint.js';

/** Builds a draft form from the published catalogue against a blueprint. */
export interface AssembleDraftForm {
  readonly blueprint: Blueprint;
  /** The sittings the form is published for (ADR-0032). */
  readonly sessionRefs: readonly string[];
  /** Restricts the corpus to one subject. */
  readonly subject?: string;
  /** The search's step budget. Defaults to the assembler's own. */
  readonly maxSteps?: number;
}

export interface PublishForm {
  readonly formId: string;
}

export interface ScheduleForm {
  readonly formId: string;
  readonly opensAt: string;
  readonly closesAt: string;
}

export interface GetForm {
  readonly formId: string;
}

/** Applies the clock to stored state: opens due forms, closes ended ones, abandons attempts a closed window left. */
export interface SweepWindows {
  readonly limit?: number;
}

/** The bytes a device downloads to sit an active form. */
export interface GetFormPackage {
  readonly formId: string;
}

/** The key a device verifies packages against (M6-26). */
export type GetPackageSigningKey = Record<string, never>;
