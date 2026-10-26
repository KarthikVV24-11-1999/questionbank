/**
 * A seeded generator (mulberry32). Every adversarial run is a function of its seed and nothing else, so a failure is a seed to replay,
 * not a story to retell. Nothing here reads a clock or `Math.random`.
 */
export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [low, high], both ends included. */
  int(low: number, high: number): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** One of the keys, with the given weights. */
  weighted<T extends string>(weights: Readonly<Record<T, number>>): T;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (low, high) => low + Math.floor(next() * (high - low + 1)),
    chance: (probability) => next() < probability,
    pick: (items) => items[Math.floor(next() * items.length)] as never,
    weighted: <T extends string>(weights: Readonly<Record<T, number>>): T => {
      const entries = Object.entries(weights) as Array<[T, number]>;
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      let point = next() * total;
      for (const [key, weight] of entries) {
        point -= weight;
        if (point < 0) return key;
      }
      return entries[entries.length - 1]![0];
    },
  };
}
