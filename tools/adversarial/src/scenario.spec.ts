import { describe, expect, it } from 'vitest';
import { createRng } from './prng.js';
import { generateScenario } from './scenario.js';

describe('the seeds', () => {
  it('give the same sequence for the same seed, and a different one for another', () => {
    const draw = (seed: number) => Array.from({ length: 8 }, () => createRng(seed).next());
    const rng = createRng(7);
    const first = Array.from({ length: 8 }, () => rng.next());
    const again = createRng(7);
    expect(Array.from({ length: 8 }, () => again.next())).toEqual(first);
    expect(draw(7)).not.toEqual(draw(8));
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it('give the same scenario for the same seed — the whole of what a run does is its seed', () => {
    for (const seed of [1, 42, 20261026, 4294967295]) expect(generateScenario(seed)).toEqual(generateScenario(seed));
    expect(JSON.stringify(generateScenario(1))).not.toEqual(JSON.stringify(generateScenario(2)));
  });

  it('give every scenario a kill, and never ask to settle while the backend is down', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const { steps } = generateScenario(seed);
      expect(steps.some((step) => step.t === 'kill'), `seed ${seed}`).toBe(true);
      let outage = 'off';
      for (const step of steps) {
        if (step.t === 'outage') outage = step.mode;
        if (step.t === 'settle') expect(outage, `seed ${seed}`).toBe('off');
      }
    }
  });

  it('cover every dimension over a hundred seeds: every kind of kill, both kinds of outage, skews both ways', () => {
    const seen = { kills: new Set<string>(), outages: new Set<string>(), skewSigns: new Set<number>() };
    for (let seed = 1; seed <= 100; seed += 1) {
      for (const step of generateScenario(seed).steps) {
        if (step.t === 'kill') seen.kills.add(step.how);
        if (step.t === 'outage') seen.outages.add(step.mode);
        if (step.t === 'wall-skew') seen.skewSigns.add(Math.sign(step.ms));
      }
    }
    expect([...seen.kills].sort()).toEqual(['quit', 'sigkill-durable', 'tab-close', 'tab-crash']);
    expect([...seen.outages].sort()).toEqual(['503', 'off', 'reset']);
    expect([...seen.skewSigns].sort()).toEqual([-1, 1]);
  });
});
