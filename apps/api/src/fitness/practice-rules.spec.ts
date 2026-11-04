import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkPracticePath, PRACTICE_PATH } from './practice-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = (name: string): string => `src/fitness-fixtures/as-practice-path/${name}`;
const rules = (options: Parameters<typeof checkPracticePath>[1]) => checkPracticePath(API_ROOT, options).map((violation) => violation.rule);

describe('a practice submission is scored without a form, and a paper\'s consumer never receives one (M8-25)', () => {
  it('holds over the shipped source', () => {
    expect(checkPracticePath(API_ROOT)).toEqual([]);
  });

  it('looked at real files: the three it governs exist and say what the rule looks for', () => {
    expect(Object.values(PRACTICE_PATH)).toHaveLength(3);
    expect(checkPracticePath(API_ROOT, { events: FIXTURE('events-practice-names-a-form.ts') }).length).toBeGreaterThan(0);
  });

  describe('is red on a planted violation', () => {
    it('a run\'s event that carries a form', () => {
      expect(rules({ events: FIXTURE('events-practice-names-a-form.ts') })).toEqual(['M8_25_PRACTICE_EVENT_NAMES_A_FORM']);
    });

    it('a paper\'s event that went nullable and changed version', () => {
      expect(rules({ events: FIXTURE('events-paper-lost-its-form.ts') })).toEqual(['M8_25_PAPER_EVENT_LOST_ITS_FORM']);
    });

    it('a paper\'s event that kept its form and changed its version', () => {
      expect(rules({ events: FIXTURE('events-paper-changed-version.ts') })).toEqual(['M8_25_PAPER_EVENT_LOST_ITS_FORM']);
    });

    it('a declared type with no consumer registered for it', () => {
      expect(rules({ composition: FIXTURE('composition-without-a-consumer.ts') })).toEqual(['M8_25_EVENT_WITHOUT_A_CONSUMER']);
    });

    it('one consumer registered for both types', () => {
      expect(rules({ composition: FIXTURE('composition-shared-consumer.ts') })).toEqual(['M8_25_CONSUMER_SHARED_BY_TWO_TYPES']);
    });

    it('a consumer for runs that reads a form', () => {
      expect(rules({ consumer: FIXTURE('consumer-reads-forms.ts') })).toEqual(['M8_25_PRACTICE_CONSUMER_READS_A_FORM']);
    });
  });

  it('names the file and the reason, so a failure says what to look at', () => {
    const [found] = checkPracticePath(API_ROOT, { consumer: FIXTURE('consumer-reads-forms.ts') });
    expect(found).toMatchObject({ file: FIXTURE('consumer-reads-forms.ts') });
    expect(found!.message).toContain('ADR-0061');
  });
});
