import { createRng, type Rng } from './prng.js';

/**
 * What a learner's bad hour looks like, as data: a seed gives a scenario, and a scenario is a list of steps. Generating one reads no
 * clock and does no I/O, so the same seed is the same scenario on every machine, and a failing run is replayed by its seed.
 */
export type SlotIndex = 0 | 1 | 2;
export type Option = 'a' | 'b' | 'c' | 'd';
export type Interruption = 'tab-crash' | 'tab-close' | 'quit' | 'sigkill-durable';
export type OutageMode = 'off' | '503' | 'reset';

export type Step =
  | { readonly t: 'answer'; readonly slot: SlotIndex; readonly option: Option }
  | { readonly t: 'clear'; readonly slot: SlotIndex }
  | { readonly t: 'flag'; readonly slot: SlotIndex; readonly on: boolean }
  | { readonly t: 'visit'; readonly slot: SlotIndex }
  | { readonly t: 'outage'; readonly mode: OutageMode }
  | { readonly t: 'wall-skew'; readonly ms: number }
  /** Wait until the page says everything captured has been sent. Only generated while the backend is up. */
  | { readonly t: 'settle' }
  | { readonly t: 'kill'; readonly how: Interruption };

export interface Scenario {
  readonly seed: number;
  readonly steps: readonly Step[];
}

const SLOTS: readonly SlotIndex[] = [0, 1, 2];
const OPTIONS: readonly Option[] = ['a', 'b', 'c', 'd'];
const HOUR = 3_600_000;
const SKEWS = [-5 * HOUR, -HOUR, -60_000, 60_000, HOUR, 5 * HOUR, 26 * HOUR] as const;

function action(rng: Rng): Step {
  const slot = rng.pick(SLOTS);
  switch (rng.weighted({ answer: 60, clear: 8, flag: 14, visit: 18 })) {
    case 'answer':
      return { t: 'answer', slot, option: rng.pick(OPTIONS) };
    case 'clear':
      return { t: 'clear', slot };
    case 'flag':
      return { t: 'flag', slot, on: rng.chance(0.6) };
    default:
      return { t: 'visit', slot };
  }
}

/**
 * Every scenario has at least one kill. Outages, a skewed wall clock and a dropped connection come and go between the actions; a
 * kill sometimes waits for the page to be fully sent first (a kill between batches) and sometimes does not (a kill mid-sync).
 */
export function generateScenario(seed: number): Scenario {
  const rng = createRng(seed);
  const steps: Step[] = [];
  let outage: OutageMode = 'off';
  const length = rng.int(10, 24);
  let kills = 0;
  const wanted = rng.int(1, 4);

  for (let index = 0; index < length || kills < 1; index += 1) {
    const roll = rng.next();
    if (roll < 0.1) {
      outage = outage === 'off' ? rng.weighted({ '503': 60, reset: 40, off: 0 }) : 'off';
      steps.push({ t: 'outage', mode: outage });
    } else if (roll < 0.18) {
      steps.push({ t: 'wall-skew', ms: rng.pick(SKEWS) });
    } else if (roll < 0.3 && kills < wanted) {
      if (outage === 'off' && rng.chance(0.5)) steps.push({ t: 'settle' });
      steps.push({ t: 'kill', how: rng.weighted({ 'tab-crash': 35, 'tab-close': 25, quit: 25, 'sigkill-durable': 15 }) });
      kills += 1;
    } else {
      steps.push(action(rng));
    }
    if (index > length + 40) break;
  }
  if (kills < 1) steps.push({ t: 'kill', how: 'tab-close' });
  return { seed, steps };
}
