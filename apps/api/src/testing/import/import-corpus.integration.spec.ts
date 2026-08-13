import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PrincipalRef } from '@questionbank/domain-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../database.js';
import { expectValue } from '../expect-result.js';
import { PostgresItemRepository } from '../../contexts/content/infrastructure/item.repository.js';
import {
  ImportItemBatchHandler,
  type ImportDependencies,
} from '../../contexts/content/application/handlers/import-handlers.js';
import type { ImportReport } from '../../contexts/content/application/import/import-batch.js';
import {
  InMemoryAuditRecorder,
  type ApplicationContext,
  type Clock,
  type IdentifierFactory,
} from '../../contexts/content/application/ports.js';
import {
  CORPUS_SIZE,
  EXPECTED_CODE,
  PLANNED_REJECTIONS,
  buildCorpus,
  corpusLines,
} from './corpus-builder.js';

/**
 * M3-45 — the milestone's fifth acceptance criterion, as a real corpus.
 *
 * **Integration, against real Postgres** (§5), and named `*.integration.spec`
 * so it lands in the serialized project: it reshapes the schema like every
 * other integration spec.
 *
 * "A correct rejection report" is read here as **the set matches** — every
 * expected rejection present under its own code, and no unexpected one. A
 * count would pass on a corpus that rejected the wrong five hundred records.
 */

const CORPUS_PATH = fileURLToPath(new URL('./corpus-500.jsonl', import.meta.url));

let database: TestDatabase;
let items: PostgresItemRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  items = new PostgresItemRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let seed = 0;
function freshUuid(): string {
  seed += 1;
  return `00000000-0000-4000-b900-${seed.toString(16).padStart(12, '0')}`;
}

const NOW = new Date('2026-08-12T09:00:00.000Z');
const clock: Clock = { now: () => NOW };
const identifiers: IdentifierFactory = { next: freshUuid };

function bench(): ImportDependencies {
  return { items, clock, identifiers, audit: new InMemoryAuditRecorder() };
}

const contentOps: PrincipalRef = {
  kind: 'human',
  id: '00000000-0000-4000-b800-000000000001',
  roleContext: ['content_ops'],
};
const as = (principal: PrincipalRef): ApplicationContext => ({
  principal,
  correlationId: 'import-corpus',
});

/** Line number → the code that line is expected to be rejected under. */
function expectedRejections(): Map<number, string> {
  return new Map(
    corpusLines()
      .filter((line) => line.plannedRejection !== undefined)
      .map((line) => [line.lineNumber, EXPECTED_CODE[line.plannedRejection as never] as string]),
  );
}

function actualRejections(report: ImportReport): Map<number, string> {
  return new Map(report.rejected.map((entry) => [entry.lineNumber, entry.code]));
}

async function importCorpus(contents: string): Promise<ImportReport> {
  return expectValue(await new ImportItemBatchHandler(bench()).handle({ contents }, as(contentOps)));
}

describe('the corpus is generated, not hand-written', () => {
  it('matches a fresh generation byte for byte', () => {
    expect(readFileSync(CORPUS_PATH, 'utf8')).toBe(`${buildCorpus()}\n`);
  });

  it('is 500 records after the header', () => {
    const lines = readFileSync(CORPUS_PATH, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(CORPUS_SIZE + 1);
    expect(corpusLines()).toHaveLength(CORPUS_SIZE);
  });

  it('carries every rejection class exactly once', () => {
    const planned = corpusLines()
      .map((line) => line.plannedRejection)
      .filter((rejection): rejection is NonNullable<typeof rejection> => rejection !== undefined);
    expect([...planned].sort()).toEqual([...PLANNED_REJECTIONS].sort());
  });

  it('is deterministic across calls, so the report is a fact and not a distribution', () => {
    expect(buildCorpus()).toBe(buildCorpus());
  });
});

describe('500 records import with an exactly-matching rejection report', () => {
  let report: ImportReport;

  beforeAll(async () => {
    report = await importCorpus(readFileSync(CORPUS_PATH, 'utf8'));
  }, 300_000);

  it('reads every record', () => {
    expect(report.totalRecords).toBe(CORPUS_SIZE);
    expect(report.imported.length + report.rejected.length).toBe(CORPUS_SIZE);
  });

  // The whole criterion: the *set* matches. Not "some records failed".
  it('rejects exactly the records the corpus plants, each under its own code', () => {
    expect(actualRejections(report)).toEqual(expectedRejections());
  });

  it('reports the domain’s own codes, not a vocabulary import invented', () => {
    for (const rejection of PLANNED_REJECTIONS) {
      expect(Object.values(EXPECTED_CODE)).toContain(EXPECTED_CODE[rejection]);
    }
    // Nothing reaches the report through the database's error text, which
    // would carry SQL into a client payload (§8).
    for (const entry of report.rejected) {
      expect(entry.code, entry.message).not.toBe('PERSISTENCE_REJECTED');
      expect(entry.message).not.toMatch(/violates check constraint|relation "/u);
    }
  });

  it('names the record and the line for every rejection, so the report is actionable', () => {
    for (const entry of report.rejected) {
      expect(entry.lineNumber, entry.code).toBeGreaterThan(1);
      // A line that never parsed has no record identifier to give; every
      // other rejection names one.
      if (entry.code !== 'RECORD_NOT_JSON') {
        expect(entry.recordId.length, entry.code).toBeGreaterThan(0);
      }
    }
  });

  it('says duplicate detection has not run, rather than that none were found', () => {
    expect(report.duplicateCheckState).toBe('deferred');
  });

  it('lands every accepted record as a retrievable draft', async () => {
    expect(report.imported.length).toBe(CORPUS_SIZE - PLANNED_REJECTIONS.length);

    for (const entry of report.imported) {
      const stored = expectValue(await items.findById(entry.itemId));
      expect(stored.lifecycleState, entry.recordId).toBe('draft');
    }
  }, 300_000);

  /**
   * The three classes M3-45 names that are **not** import rejections, carried
   * as accepted records and asserted to be accepted.
   *
   * Rejecting `unresolved` licensing at import would mean an item could not be
   * imported before its rights were settled, which inverts FR-QM-05 rule 4 —
   * that rule blocks *publication*, which is where M3-11 enforces it, and
   * M3-06 makes `unresolved` the default a new draft starts from. Requiring a
   * solution at import would make a previous-year corpus unimportable, which
   * is the corpus this path exists for. And "unrenderable" is the verdict
   * `validateRender` produces at publication; a second, weaker notion of it
   * here would be the parallel validator DEC-7 forbids.
   */
  it('imports unresolved licensing and solution-less records rather than rejecting them', async () => {
    const accepted = corpusLines().filter((line) => line.plannedRejection === undefined);
    const rejectedLines = new Set(report.rejected.map((entry) => entry.lineNumber));

    for (const line of accepted) expect(rejectedLines.has(line.lineNumber), line.recordId).toBe(false);

    const unresolved = report.imported.find(
      (entry) => entry.lineNumber === (corpusLines()[PLANNED_REJECTIONS.length] as { lineNumber: number }).lineNumber,
    );
    expect(unresolved).toBeDefined();
    const stored = expectValue(await items.findById(unresolved?.itemId as string));
    expect(stored.versions[0]?.licensing.status).toBe('unresolved');
  });
});

describe('the exactness check can fail', () => {
  /**
   * The instrument, shown to fail before it is trusted — in both directions.
   * A check that only counted failures would report the same number and pass
   * on either of these.
   *
   * The edits are made by line position rather than by searching the text: a
   * string replacement that silently matched nothing would leave the corpus
   * intact and the test would pass by having changed nothing at all.
   */
  function corpusWithLineReplaced(lineNumber: number, replacement: string): string {
    const lines = readFileSync(CORPUS_PATH, 'utf8').trimEnd().split('\n');
    lines[lineNumber - 1] = replacement;
    return lines.join('\n');
  }

  function recordAt(lineNumber: number): Record<string, unknown> {
    const lines = readFileSync(CORPUS_PATH, 'utf8').trimEnd().split('\n');
    return JSON.parse(lines[lineNumber - 1] as string) as Record<string, unknown>;
  }

  it('notices when a record that should be rejected is accepted', async () => {
    const planted = corpusLines().find((line) => line.plannedRejection === 'MISSING_TAG');
    expect(planted).toBeDefined();

    const repaired = {
      ...recordAt(planted?.lineNumber as number),
      taxonomyTags: [
        {
          conceptIdentityId: '019fd4bc-9001-7000-8000-000000000001',
          taxonomyVersionId: '019fd4bc-9000-7000-8000-000000000002',
          weight: 1,
          isPrimary: true,
        },
      ],
    };

    const report = await importCorpus(
      corpusWithLineReplaced(planted?.lineNumber as number, JSON.stringify(repaired)),
    );

    expect(actualRejections(report)).not.toEqual(expectedRejections());
    expect(report.rejected.map((entry) => entry.code)).not.toContain('TAGS_REQUIRED');
  }, 300_000);

  it('notices when a record that should be accepted is rejected', async () => {
    const accepted = corpusLines().find((line) => line.plannedRejection === undefined);
    expect(accepted).toBeDefined();

    const spoiled = {
      ...recordAt(accepted?.lineNumber as number),
      difficultyEstimate: 'nonsense',
    };

    const report = await importCorpus(
      corpusWithLineReplaced(accepted?.lineNumber as number, JSON.stringify(spoiled)),
    );

    expect(actualRejections(report)).not.toEqual(expectedRejections());
    expect(actualRejections(report).get(accepted?.lineNumber as number)).toBe(
      'DIFFICULTY_BAND_UNKNOWN',
    );
  }, 300_000);
});
