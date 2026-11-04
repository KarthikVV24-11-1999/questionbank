import { describe, expect, it } from 'vitest';
import { screenHref } from './screen-context.js';

describe('the address of a screen', () => {
  it('names the screen and the thing, and carries nothing about the learner: the exam they chose and its syllabus are read from the server, not from the address', () => {
    expect(screenHref({ practice: 'run-1' })).toBe('?practice=run-1');
    expect(screenHref({ report: 'att-1' })).toBe('?report=att-1');
    expect(screenHref({ onboarding: true })).toBe('?onboarding=1');
    expect(screenHref({ onboarding: 'coverage' })).toBe('?onboarding=coverage');
    expect(screenHref({ map: true })).toBe('?map=1');
    expect(screenHref({ topic: 'topic-1' })).toBe('?topic=topic-1');
  });

  it('is the bare home address for home', () => {
    expect(screenHref({})).toBe('?');
  });

  it('names the page of answers of a topic, and leaves out the first page, which is the topic', () => {
    expect(screenHref({ topic: 'topic-1', from: 20 })).toBe('?topic=topic-1&from=20');
    expect(screenHref({ topic: 'topic-1', from: 0 })).toBe('?topic=topic-1');
  });

  it('never carries the exam profile or the syllabus version, whichever screen it opens', () => {
    for (const screen of [{ practice: 'a' }, { report: 'a' }, { onboarding: true as const }, { map: true as const }, { topic: 'a', from: 5 }, {}]) {
      expect(screenHref(screen)).not.toMatch(/profile|taxonomy/u);
    }
  });
});
