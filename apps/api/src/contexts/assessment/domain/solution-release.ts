declare const releasedSlotBrand: unique symbol;

/**
 * A slot whose solution the effort gate has opened (FRS 277, M7-36). **It cannot be made from an attempt id and a slot id by anyone who asks**: the
 * brand makes the type nominal, and the one place that constructs a value is the repository that reads the database's `solution_release` view
 * (`infrastructure/solution-release.repository.ts`). A function that serves a solution takes a `ReleasedSlot`, so reaching a solution without passing the
 * gate is a type error, and a fitness rule fails a second constructor.
 *
 * How soon a slot is released is the attempt's pinned delivery, not its mode (DEC-M7-17). The item version it carries is the one the slot pinned, read from the same row that said the slot was released.
 */
export interface ReleasedSlot {
  readonly [releasedSlotBrand]: true;
  readonly attemptId: string;
  readonly slotId: string;
  readonly itemVersionId: string;
}

/**
 * Makes a `ReleasedSlot`. **Only the repository behind the database's view calls this**, and the fitness rule `SOLUTION_RELEASE_FORGED` fails any other
 * production caller. Tests build one through the in-memory release source in `testing/assessment-fakes.ts`.
 */
export function makeReleasedSlot(attemptId: string, slotId: string, itemVersionId: string): ReleasedSlot {
  return Object.freeze({ attemptId, slotId, itemVersionId }) as ReleasedSlot;
}
