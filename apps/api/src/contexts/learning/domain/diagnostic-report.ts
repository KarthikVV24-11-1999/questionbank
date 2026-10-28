/**
 * `DiagnosticReport` — what a learner lost marks to, by concept, ranked (M7-41, M7-42, M7-43).
 *
 * **A finding is a concept and what it cost.** Each slot of a scored mock is attributed to its item's primary concept (DEC-M7-5), and the marks the learner did not
 * earn on it are added to that concept: what was available less what was awarded, where that is positive. A wrong answer under negative marking costs the marks it
 * took away as well as the marks it did not earn, which is the number that moved the learner's total.
 *
 * **Ranked by marks lost, not by how many answers were wrong.** A concept that cost four marks on one hard question outranks one that cost two across three easy
 * ones. Ties are broken by the concept's identifier, so the same attempt always gives the same order.
 *
 * **A skipped slot contributes its marks (DEC-M7-21).** The learner lost those marks to that concept whether or not they tried, and a report that left them out would
 * rank a concept they avoided below one they attempted and got wrong. It is not evidence of anything (DEC-M7-15) and moves no mastery state; the finding counts such
 * slots separately, so a reader can tell *attempted and lost* from *avoided*. A dropped slot has no marks to lose, a bonus slot paid in full, and an
 * indeterminate one could not be judged: none of them is the learner's loss.
 *
 * Marks are decimal text throughout and are never read through a double.
 */
export interface ReportSlot {
  readonly slotRef: string;
  readonly conceptIdentityId: string;
  readonly taxonomyVersionId: string;
  /** Scoring's word for what happened to the slot. */
  readonly outcome: string;
  readonly marksAwarded: string;
  readonly marksAvailable: string;
}

export interface Finding {
  /** 1 is the concept that cost the most. */
  readonly rank: number;
  readonly conceptIdentityId: string;
  readonly taxonomyVersionId: string;
  readonly marksLost: string;
  /** What the slots that cost marks were worth, so a reader can say "lost 9 of 12". */
  readonly marksAvailable: string;
  /** Slots that cost marks, skipped ones included. */
  readonly slots: number;
  /** Of those, the ones the learner did not attempt. */
  readonly skipped: number;
}

const SCALE = 4;
const UNIT = 10n ** BigInt(SCALE);
const NOT_THE_LEARNERS_LOSS: readonly string[] = ['dropped', 'bonus', 'indeterminate'];

function toUnits(text: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(text);
  if (match === null) throw new Error(`diagnostic report: "${text}" is not a decimal mark`);
  const fraction = (match[3] ?? '').padEnd(SCALE, '0').slice(0, SCALE);
  const units = BigInt(match[2]!) * UNIT + BigInt(fraction);
  return match[1] === '-' ? -units : units;
}

export function fromUnits(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const magnitude = units < 0n ? -units : units;
  const whole = magnitude / UNIT;
  const fraction = (magnitude % UNIT).toString().padStart(SCALE, '0').replace(/0+$/u, '');
  return `${sign}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

export function findingsOf(slots: readonly ReportSlot[]): readonly Finding[] {
  const byConcept = new Map<string, { slot: ReportSlot; lost: bigint; available: bigint; count: number; skipped: number }>();
  for (const slot of slots) {
    if (NOT_THE_LEARNERS_LOSS.includes(slot.outcome)) continue;
    const available = toUnits(slot.marksAvailable);
    const lost = available - toUnits(slot.marksAwarded);
    if (lost <= 0n) continue;
    const key = `${slot.taxonomyVersionId}:${slot.conceptIdentityId}`;
    const held = byConcept.get(key) ?? { slot, lost: 0n, available: 0n, count: 0, skipped: 0 };
    byConcept.set(key, { slot: held.slot, lost: held.lost + lost, available: held.available + available, count: held.count + 1, skipped: held.skipped + (slot.outcome === 'unattempted' ? 1 : 0) });
  }
  const ordered = [...byConcept.entries()].sort(([ka, a], [kb, b]) => (a.lost === b.lost ? (ka < kb ? -1 : 1) : a.lost > b.lost ? -1 : 1));
  return Object.freeze(
    ordered.map(([, held], index) =>
      Object.freeze({
        rank: index + 1,
        conceptIdentityId: held.slot.conceptIdentityId,
        taxonomyVersionId: held.slot.taxonomyVersionId,
        marksLost: fromUnits(held.lost),
        marksAvailable: fromUnits(held.available),
        slots: held.count,
        skipped: held.skipped,
      }),
    ),
  );
}
