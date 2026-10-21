import { MINIMUM_ANCHOR_PERCENT, type FormSection, type FormSlot } from './form.js';
import {
  BLUEPRINT_DIFFICULTY_BANDS,
  BLUEPRINT_ITEM_TYPES,
  type Blueprint,
  type BlueprintDifficultyBand,
  type BlueprintItemType,
} from './blueprint.js';
import { preconditionFailedError, type AssessmentError } from './assessment-error.js';
import { err, ok, type Result } from './result.js';

/**
 * Form assembly (ASSESSMENT-ENGINE §6): **greedy selection with backtracking,
 * not a constraint solver.** The eligible pool is large relative to the
 * constraints, so a CSP solver would be complexity without benefit at that
 * ratio. This is a depth-first search that tries the best-scoring candidate
 * for each slot and undoes a choice only when a later slot cannot be filled.
 *
 * ## Hard and soft, which is the thing most likely to be lost
 *
 * **Hard constraints decide validity.** A form that breaks one is not a form,
 * and assembly *fails* — with a refusal that names the constraint — rather
 * than return something nearly right:
 *
 *  1. item count per section, exact
 *  2. item type mix, exact
 *  3. total marks, exact
 *  4. only published items
 *  5. no two items sharing a stimulus across different sections
 *  6. no near-duplicates within one form (content's own detection, supplied)
 *  7. at least 15% anchor items from the pool (F50)
 *
 * **Soft constraints decide only which valid form.** Difficulty distribution,
 * concept coverage and exposure balance change the *order candidates are
 * tried in* and nothing else. A form that misses a soft target is still a
 * form: it is returned, and the report says by how much it missed.
 *
 * Pure and deterministic: same candidates and blueprint, same form, whatever
 * order the candidates arrive in. It reads no clock and generates no id — slot
 * ids come from the caller.
 */
export const HARD_CONSTRAINTS = [
  'ITEM_COUNT',
  'TYPE_MIX',
  'TOTAL_MARKS',
  'PUBLISHED_ONLY',
  'STIMULUS_SPLIT',
  'NEAR_DUPLICATE',
  'ANCHOR_FLOOR',
] as const;
export type HardConstraint = (typeof HARD_CONSTRAINTS)[number];

export interface AssemblyCandidate {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly itemType: BlueprintItemType;
  readonly difficultyBand: BlueprintDifficultyBand;
  readonly conceptIdentityIds: readonly string[];
  readonly stimulusVersionId: string | null;
  /** Whether the content catalogue lists it as published and not retired. */
  readonly isPublished: boolean;
  /** Whether the item version is in the anchor pool right now. */
  readonly isAnchor: boolean;
  /** The pool's cap on forms this version may anchor; `null` for a non-anchor. */
  readonly anchorExposureCap: number | null;
}

export interface AssemblyInput {
  readonly blueprint: Blueprint;
  readonly candidates: readonly AssemblyCandidate[];
  /** Forms each item version has already been placed in, from the exposure ledger. Absent means none. */
  readonly exposure: ReadonlyMap<string, number>;
  /** For each item version, the versions content's detection calls near-duplicates of it. */
  readonly nearDuplicates: ReadonlyMap<string, ReadonlySet<string>>;
  readonly newSlotId: (sectionOrdinal: number, slotOrdinal: number) => string;
  /** Nodes the search may expand before giving up. Defaults to 200,000. */
  readonly maxSteps?: number;
  /** Whether a choice may be undone. Defaults to true; false is greedy alone, kept so a test can show backtracking is what makes a case succeed. */
  readonly backtracking?: boolean;
}

export interface SoftReport {
  /** Items by which the form falls short of the blueprint's difficulty targets, summed over sections and bands. */
  readonly difficultyShortfall: number;
  readonly withinDifficultyTolerance: boolean;
  readonly distinctConcepts: number;
  /** Mean prior exposure of the chosen item versions. */
  readonly meanExposure: number;
}

export interface AssembledForm {
  readonly sections: readonly FormSection[];
  readonly soft: SoftReport;
}

export type AssemblyErrorCode = 'ASSEMBLY_INFEASIBLE' | 'ASSEMBLY_SEARCH_EXHAUSTED';

export interface AssemblyError extends AssessmentError<AssemblyErrorCode> {
  /** The hard constraint that could not be met. */
  readonly constraint: HardConstraint;
}

function refusal(code: AssemblyErrorCode, constraint: HardConstraint, message: string): AssemblyError {
  return Object.freeze({ ...preconditionFailedError(code, message, constraint), constraint });
}

/** The fewest anchors that satisfy the floor over `total` slots, in whole numbers. */
export function requiredAnchors(total: number): number {
  return Math.ceil((total * MINIMUM_ANCHOR_PERCENT) / 100);
}

interface PlannedSlot {
  readonly section: number;
  readonly ordinal: number;
  readonly itemType: BlueprintItemType;
}

function planSlots(blueprint: Blueprint): PlannedSlot[] {
  const planned: PlannedSlot[] = [];
  for (const section of blueprint.sections) {
    let ordinal = 0;
    for (const itemType of BLUEPRINT_ITEM_TYPES) {
      for (let i = 0; i < (section.typeMix[itemType] ?? 0); i += 1) {
        ordinal += 1;
        planned.push({ section: section.ordinal, ordinal, itemType });
      }
    }
  }
  return planned;
}

function isNearDuplicate(
  a: AssemblyCandidate,
  b: AssemblyCandidate,
  nearDuplicates: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  return nearDuplicates.get(a.itemVersionId)?.has(b.itemVersionId) === true || nearDuplicates.get(b.itemVersionId)?.has(a.itemVersionId) === true;
}

/** Said before any search: the constraints a pool cannot meet however it is arranged. */
function supplyFault(input: AssemblyInput, eligible: readonly AssemblyCandidate[], slots: readonly PlannedSlot[]): AssemblyError | null {
  const { blueprint, candidates } = input;
  const marks = blueprint.sections.reduce((sum, section) => sum + section.itemCount * section.marksPerItem, 0);
  if (marks !== blueprint.totalMarks) {
    return refusal('ASSEMBLY_INFEASIBLE', 'TOTAL_MARKS', `the sections are worth ${marks} marks and the blueprint asks for ${blueprint.totalMarks}`);
  }
  const published = candidates.filter((candidate) => candidate.isPublished);
  if (published.length < slots.length) {
    return candidates.length >= slots.length
      ? refusal('ASSEMBLY_INFEASIBLE', 'PUBLISHED_ONLY', `only ${published.length} of ${candidates.length} candidates are published, and ${slots.length} slots need filling`)
      : refusal('ASSEMBLY_INFEASIBLE', 'ITEM_COUNT', `${candidates.length} candidates cannot fill ${slots.length} slots`);
  }
  if (eligible.length < slots.length) {
    return refusal('ASSEMBLY_INFEASIBLE', 'ITEM_COUNT', `${eligible.length} eligible candidates cannot fill ${slots.length} slots`);
  }
  for (const itemType of BLUEPRINT_ITEM_TYPES) {
    const needed = slots.filter((slot) => slot.itemType === itemType).length;
    const available = new Set(eligible.filter((candidate) => candidate.itemType === itemType).map((candidate) => candidate.itemId)).size;
    if (available < needed) {
      return refusal('ASSEMBLY_INFEASIBLE', 'TYPE_MIX', `${needed} ${itemType} items are needed and ${available} are eligible`);
    }
  }
  const anchors = new Set(eligible.filter((candidate) => candidate.isAnchor).map((candidate) => candidate.itemId)).size;
  if (anchors < requiredAnchors(slots.length)) {
    return refusal('ASSEMBLY_INFEASIBLE', 'ANCHOR_FLOOR', `${requiredAnchors(slots.length)} anchor items are needed and ${anchors} are eligible`);
  }
  return null;
}

const DEFAULT_MAX_STEPS = 200_000;

/**
 * Assembles a form, or says which hard constraint stopped it. See the module
 * header for what is hard and what is soft.
 */
export function assembleForm(input: AssemblyInput): Result<AssembledForm, AssemblyError> {
  const { blueprint } = input;
  const slots = planSlots(blueprint);
  const exposureOf = (candidate: AssemblyCandidate): number => input.exposure.get(candidate.itemVersionId) ?? 0;

  // Sorted once, so the order candidates arrive in can never change the result.
  const eligible = [...input.candidates]
    .filter((candidate) => candidate.isPublished)
    // An anchor past its exposure cap is no longer offered: it is reserved, and the cap is what keeps its statistics stable.
    .filter((candidate) => !candidate.isAnchor || candidate.anchorExposureCap === null || exposureOf(candidate) < candidate.anchorExposureCap)
    .sort((a, b) => (a.itemVersionId < b.itemVersionId ? -1 : 1)); // version ids are unique, so there is no tie

  const fault = supplyFault(input, eligible, slots);
  if (fault !== null) return err(fault);

  const anchorsNeeded = requiredAnchors(slots.length);
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  const backtracking = input.backtracking ?? true;

  // Search state, all of it undone on backtrack.
  const chosen: AssemblyCandidate[] = [];
  const usedItems = new Set<string>();
  const stimulusSection = new Map<string, number>();
  const conceptCounts = new Map<string, number>();
  const targets = new Map<number, Map<BlueprintDifficultyBand, number>>(
    blueprint.sections.map((section) => [
      section.ordinal,
      new Map(BLUEPRINT_DIFFICULTY_BANDS.map((band) => [band, section.difficultyTarget[band] ?? 0])),
    ]),
  );
  let anchorsChosen = 0;
  let steps = 0;
  let exhausted = false;
  let deepest: { index: number; constraint: HardConstraint } = { index: -1, constraint: 'ITEM_COUNT' };

  /** Soft ordering: the band still wanted, then a concept not yet covered, then the least exposed. Never a filter. */
  const rank = (candidate: AssemblyCandidate, section: number): readonly number[] => [
    targets.get(section)!.get(candidate.difficultyBand)! > 0 ? 0 : 1,
    candidate.conceptIdentityIds.some((concept) => !conceptCounts.has(concept)) ? 0 : 1,
    exposureOf(candidate),
  ];
  const compareRanks = (a: readonly number[], b: readonly number[]): number => {
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
    return 0;
  };

  const place = (candidate: AssemblyCandidate, section: number): void => {
    chosen.push(candidate);
    usedItems.add(candidate.itemId);
    if (candidate.stimulusVersionId !== null) stimulusSection.set(candidate.stimulusVersionId, section);
    for (const concept of candidate.conceptIdentityIds) conceptCounts.set(concept, (conceptCounts.get(concept) ?? 0) + 1);
    const band = targets.get(section)!;
    band.set(candidate.difficultyBand, band.get(candidate.difficultyBand)! - 1);
    if (candidate.isAnchor) anchorsChosen += 1;
  };

  const unplace = (candidate: AssemblyCandidate, section: number, hadStimulus: boolean): void => {
    chosen.pop();
    usedItems.delete(candidate.itemId);
    // A stimulus is released only if no other chosen item still holds it.
    if (candidate.stimulusVersionId !== null && !hadStimulus) stimulusSection.delete(candidate.stimulusVersionId);
    for (const concept of candidate.conceptIdentityIds) {
      const left = conceptCounts.get(concept)! - 1;
      if (left === 0) conceptCounts.delete(concept);
      else conceptCounts.set(concept, left);
    }
    const band = targets.get(section)!;
    band.set(candidate.difficultyBand, band.get(candidate.difficultyBand)! + 1);
    if (candidate.isAnchor) anchorsChosen -= 1;
  };

  const search = (index: number): boolean => {
    if (index === slots.length) return true;
    const slot = slots[index]!;
    const ranked = eligible
      .filter((candidate) => candidate.itemType === slot.itemType && !usedItems.has(candidate.itemId))
      .map((candidate) => ({ candidate, key: rank(candidate, slot.section) }))
      .sort((a, b) => compareRanks(a.key, b.key));

    const rejections = new Map<HardConstraint, number>();
    const reject = (constraint: HardConstraint): void => {
      rejections.set(constraint, (rejections.get(constraint) ?? 0) + 1);
    };

    for (const { candidate } of ranked) {
      if (exhausted) return false;
      if (candidate.stimulusVersionId !== null && (stimulusSection.get(candidate.stimulusVersionId) ?? slot.section) !== slot.section) {
        reject('STIMULUS_SPLIT');
        continue;
      }
      if (chosen.some((already) => isNearDuplicate(already, candidate, input.nearDuplicates))) {
        reject('NEAR_DUPLICATE');
        continue;
      }
      // Anchors still obtainable from here must close the gap, or this branch cannot reach the floor.
      if (anchorsChosen + (candidate.isAnchor ? 1 : 0) + (slots.length - index - 1) < anchorsNeeded) {
        reject('ANCHOR_FLOOR');
        continue;
      }
      steps += 1;
      if (steps > maxSteps) {
        exhausted = true;
        return false;
      }
      const hadStimulus = candidate.stimulusVersionId !== null && stimulusSection.has(candidate.stimulusVersionId);
      place(candidate, slot.section);
      if (search(index + 1)) return true;
      unplace(candidate, slot.section, hadStimulus);
      // Greedy alone: the first acceptable candidate is the only one tried.
      if (!backtracking) break;
    }

    if (index >= deepest.index) {
      // The constraint that turned most candidates away here; with none turned away, what was blocking before.
      const worst = [...rejections.entries()].reduce<readonly [HardConstraint, number]>(
        (best, entry) => (entry[1] > best[1] ? entry : best),
        [deepest.constraint, 0],
      );
      deepest = { index, constraint: worst[0] };
    }
    return false;
  };

  if (!search(0)) {
    return err(
      exhausted
        ? refusal('ASSEMBLY_SEARCH_EXHAUSTED', deepest.constraint, `no form was found within ${maxSteps} steps; ${deepest.constraint} was what kept blocking it`)
        : refusal('ASSEMBLY_INFEASIBLE', deepest.constraint, `no arrangement of the eligible items satisfies ${deepest.constraint}`),
    );
  }

  const sections: FormSection[] = blueprint.sections.map((section) => {
    const own = slots.map((slot, i) => ({ slot, candidate: chosen[i]! })).filter(({ slot }) => slot.section === section.ordinal);
    return {
      ordinal: section.ordinal,
      sectionSpecRef: section.sectionSpecRef,
      slots: own.map<FormSlot>(({ slot, candidate }) => ({
        slotId: input.newSlotId(section.ordinal, slot.ordinal),
        ordinal: slot.ordinal + blueprint.sections.filter((s) => s.ordinal < section.ordinal).reduce((n, s) => n + s.itemCount, 0),
        itemId: candidate.itemId,
        itemVersionId: candidate.itemVersionId,
        stimulusVersionId: candidate.stimulusVersionId,
        marksAvailable: section.marksPerItem,
        isAnchor: candidate.isAnchor,
      })),
    };
  });

  let shortfall = 0;
  for (const section of blueprint.sections) {
    const picked = chosen.filter((_, i) => slots[i]!.section === section.ordinal);
    for (const band of BLUEPRINT_DIFFICULTY_BANDS) {
      const have = picked.filter((candidate) => candidate.difficultyBand === band).length;
      shortfall += Math.max(0, (section.difficultyTarget[band] ?? 0) - have);
    }
  }
  const soft: SoftReport = Object.freeze({
    difficultyShortfall: shortfall,
    withinDifficultyTolerance: shortfall <= blueprint.difficultyTolerance,
    distinctConcepts: new Set(chosen.flatMap((candidate) => candidate.conceptIdentityIds)).size,
    meanExposure: chosen.reduce((sum, candidate) => sum + exposureOf(candidate), 0) / chosen.length,
  });
  return ok(Object.freeze({ sections: Object.freeze(sections), soft }));
}

/**
 * An independent check of a finished assembly against the hard constraints,
 * written separately from the search that produced it: a search that has a bug
 * and a checker that shares it prove nothing. Returns every constraint broken,
 * empty when the form is valid.
 */
export function violatedConstraints(input: AssemblyInput, assembled: readonly FormSection[]): readonly HardConstraint[] {
  const broken = new Set<HardConstraint>();
  const byVersion = new Map(input.candidates.map((candidate) => [candidate.itemVersionId, candidate]));
  const picked = assembled.flatMap((section) => section.slots.map((slot) => ({ section: section.ordinal, slot, candidate: byVersion.get(slot.itemVersionId) })));

  for (const section of input.blueprint.sections) {
    const own = picked.filter((entry) => entry.section === section.ordinal);
    if (own.length !== section.itemCount) broken.add('ITEM_COUNT');
    for (const itemType of BLUEPRINT_ITEM_TYPES) {
      if (own.filter((entry) => entry.candidate?.itemType === itemType).length !== (section.typeMix[itemType] ?? 0)) broken.add('TYPE_MIX');
    }
  }
  if (assembled.length !== input.blueprint.sections.length) broken.add('ITEM_COUNT');
  if (picked.reduce((sum, entry) => sum + entry.slot.marksAvailable, 0) !== input.blueprint.totalMarks) broken.add('TOTAL_MARKS');
  if (picked.some((entry) => entry.candidate === undefined || !entry.candidate.isPublished)) broken.add('PUBLISHED_ONLY');
  if (new Set(picked.map((entry) => entry.slot.itemId)).size !== picked.length) broken.add('ITEM_COUNT');

  const stimulusSections = new Map<string, Set<number>>();
  for (const entry of picked) {
    if (entry.slot.stimulusVersionId !== null) {
      stimulusSections.set(entry.slot.stimulusVersionId, (stimulusSections.get(entry.slot.stimulusVersionId) ?? new Set()).add(entry.section));
    }
  }
  if ([...stimulusSections.values()].some((sections) => sections.size > 1)) broken.add('STIMULUS_SPLIT');

  for (const a of picked) {
    for (const b of picked) {
      if (a !== b && input.nearDuplicates.get(a.slot.itemVersionId)?.has(b.slot.itemVersionId) === true) broken.add('NEAR_DUPLICATE');
    }
  }
  if (picked.filter((entry) => entry.slot.isAnchor).length * 100 < picked.length * MINIMUM_ANCHOR_PERCENT) broken.add('ANCHOR_FLOOR');
  return [...broken];
}
