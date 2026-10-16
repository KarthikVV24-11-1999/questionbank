import { describe, expect, it } from 'vitest';
import type { DuplicateCandidatesResult, FindingCode, ValidationReport } from '../../../content/public/index.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { aCandidate, aRun } from '../../../../testing/generation-fixtures.js';
import { contextFor, principalWith } from '../../../../testing/generation-context.js';
import { err, ok } from '../../domain/result.js';
import { PRECHECKS } from '../../domain/precheck-vocabulary.js';
import { applicationError } from '../authorization.js';
import type { ContentProposalChecks } from '../ports.js';
import { contentValidationCheck, duplicateDetectionCheck, type ContentValidationCheckId } from './content-checks.js';

const machine = contextFor(principalWith(['generation_pipeline'], 'system'));
const clock = { now: () => new Date('2026-10-16T09:30:00.000Z') };
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const BODY = {
  stem: { schemaVersion: 1, blocks: [] },
  responseSpec: { itemType: 'SINGLE_CORRECT_MCQ', options: [], correctOptionId: 'a' },
  taxonomyTags: [],
  difficultyEstimate: 'moderate',
  subject: 'physics',
  licensing: { status: 'owned' },
  solution: { steps: ['x'] },
};
const candidate = (body: Record<string, unknown> = BODY, itemType = 'SINGLE_CORRECT_MCQ') =>
  aCandidate(aRun({ modelVersionId: UUID(1), promptVersionId: UUID(2) }), { body, itemType });

const finding = (code: FindingCode, location = 'version.stem', severity: 'blocking' | 'warning' = 'blocking') => ({ code, severity, message: `${code} message`, location });
const report = (...findings: ReturnType<typeof finding>[]): ValidationReport => ({
  findings,
  blocking: findings.filter((entry) => entry.severity === 'blocking'),
  warnings: findings.filter((entry) => entry.severity === 'warning'),
  maySubmit: findings.every((entry) => entry.severity !== 'blocking'),
  duplicateCheckState: 'not_evaluated',
});

function content(options: { report?: ValidationReport; duplicates?: DuplicateCandidatesResult } = {}) {
  const calls = { validate: [] as unknown[], duplicates: [] as unknown[] };
  const checks: ContentProposalChecks = {
    validate: (draft, facts) => (calls.validate.push({ draft, facts }), options.report ?? report()),
    duplicates: async (query) => (calls.duplicates.push(query), ok(options.duplicates ?? EMPTY_DUPLICATES)),
  };
  return { checks, calls };
}
const EMPTY_DUPLICATES: DuplicateCandidatesResult = { state: 'evaluated', exactMatches: [], skeletonMatches: [], trigramMatches: [], asOf: '2026-10-16T09:30:00.000Z' };
const run = (check: ContentValidationCheckId, checks: ContentProposalChecks, subject = candidate()) =>
  contentValidationCheck(check, { content: checks, clock }).run(subject, machine);

describe.each(['schema_validity', 'renderability', 'numeric_spec_completeness'] as const)('%s', (check) => {
  it('is the vocabulary’s blocking check, and passes when content finds nothing of its own', async () => {
    expect(PRECHECKS.find((entry) => entry.id === check)?.severity).toBe('blocking');
    const outcome = expectValue(await run(check, content().checks));
    expect(outcome.outcome).toBe('pass');
    expect((outcome.detail ?? '').length).toBeGreaterThan(30);
  });

  it('hands content the draft’s content, an instant it was given, and whether a solution came with it', async () => {
    const { checks, calls } = content();
    await run(check, checks);
    const [asked] = calls.validate as { draft: { provenance: { sourceType: string } }; facts: { asOf: string; solutionProvided: boolean } }[];
    expect(asked?.draft.provenance.sourceType).toBe('ai_generated');
    expect(asked?.facts).toEqual({ asOf: '2026-10-16T09:30:00.000Z', solutionProvided: true });
  });

  it('says a solution did not come with it when the proposal carries none, or something else in its place', async () => {
    for (const solution of [undefined, null, 'text', ['a']]) {
      const { checks, calls } = content();
      await run(check, checks, candidate({ ...BODY, solution }));
      expect((calls.validate[0] as { facts: { solutionProvided: boolean } }).facts.solutionProvided).toBe(false);
    }
  });

  it('cannot run when the proposal cannot be assembled for a reason that is not its structure — content’s provenance is check 12’s', async () => {
    const unassemblable = { ...candidate(), confidence: 9 };
    const failure = expectError(await run(check, content().checks, unassemblable));
    expect(failure.kind).toBe('PreconditionFailed');
    expect(failure.code).toBe('PROVENANCE_CONFIDENCE_OUT_OF_RANGE');
  });
});

describe('a finding is read by the check that owns it, and only that one', () => {
  const everyBlocking = report(
    finding('STRUCTURE_INVALID', 'version.taxonomyTags'),
    finding('CONCEPT_TAG_MISSING', 'version.taxonomyTags'),
    finding('NOTATION_UNRENDERABLE', 'version.stem'),
    finding('NUMERIC_TOLERANCE_MISSING', 'version.responseSpec.spec'),
    finding('LICENSING_UNRESOLVED', 'version.licensing'),
    finding('SOLUTION_MISSING', 'solution'),
  );

  it('schema_validity reads structure and tags; renderability reads notation; numeric reads tolerance', async () => {
    const { checks } = content({ report: everyBlocking });
    const schema = expectValue(await run('schema_validity', checks));
    const rendering = expectValue(await run('renderability', checks));
    const numeric = expectValue(await run('numeric_spec_completeness', checks));

    expect(schema).toEqual({ outcome: 'fail', detail: 'STRUCTURE_INVALID at version.taxonomyTags: STRUCTURE_INVALID message; CONCEPT_TAG_MISSING at version.taxonomyTags: CONCEPT_TAG_MISSING message' });
    expect(rendering).toEqual({ outcome: 'fail', detail: 'NOTATION_UNRENDERABLE at version.stem: NOTATION_UNRENDERABLE message' });
    expect(numeric).toEqual({ outcome: 'fail', detail: 'NUMERIC_TOLERANCE_MISSING at version.responseSpec.spec: NUMERIC_TOLERANCE_MISSING message' });
  });

  it('licensing and a missing solution are other checks’ — none of the three fails on them', async () => {
    const { checks } = content({ report: report(finding('LICENSING_UNRESOLVED'), finding('SOLUTION_MISSING')) });
    for (const check of ['schema_validity', 'renderability', 'numeric_spec_completeness'] as const) {
      expect(expectValue(await run(check, checks)).outcome, check).toBe('pass');
    }
  });

  it('a warning is advice and fails none of them', async () => {
    const { checks } = content({ report: report(finding('DIFFICULTY_UNUSUAL', 'version.difficultyEstimate', 'warning'), finding('DISTRACTOR_ANALYSIS_MISSING', 'x', 'warning')) });
    for (const check of ['schema_validity', 'renderability', 'numeric_spec_completeness'] as const) {
      expect(expectValue(await run(check, checks)).outcome, check).toBe('pass');
    }
  });

  it('an answer key the executor refuses is a numeric problem for a numeric item and a structural one for any other', async () => {
    const { checks } = content({ report: report(finding('ANSWER_KEY_MISSING', 'version.responseSpec')) });
    expect(expectValue(await run('schema_validity', checks, candidate())).outcome).toBe('fail');
    expect(expectValue(await run('numeric_spec_completeness', checks, candidate())).outcome).toBe('pass');

    const numericItem = candidate(BODY, 'NUMERIC');
    expect(expectValue(await run('numeric_spec_completeness', checks, numericItem)).outcome).toBe('fail');
    expect(expectValue(await run('schema_validity', checks, numericItem)).outcome).toBe('pass');
  });
});

describe('a proposal missing what a draft is made of', () => {
  it('fails the structural check, naming the key, and leaves the other two nothing to look at', async () => {
    const { subject: _subject, ...noSubject } = BODY;
    const { checks, calls } = content();
    const structure = expectValue(await run('schema_validity', checks, candidate(noSubject)));
    expect(structure.outcome).toBe('fail');
    expect(structure.detail).toContain('subject');
    for (const check of ['renderability', 'numeric_spec_completeness'] as const) {
      expect(expectError(await run(check, checks, candidate(noSubject))).code).toBe('PROPOSAL_FIELD_MISSING');
    }
    expect(calls.validate).toEqual([]);
  });
});

describe('duplicate_detection (check 8, advisory)', () => {
  const entry = (itemVersionId: string, similarity?: number) => ({ itemId: `i-${itemVersionId}`, itemVersionId, subject: 'physics', ...(similarity === undefined ? {} : { similarity }) });
  const check = (checks: ContentProposalChecks) => duplicateDetectionCheck({ content: checks });
  const run8 = (checks: ContentProposalChecks, subject = candidate()) => check(checks).run(subject, machine);

  it('is the vocabulary’s advisory check', () => {
    expect(PRECHECKS.find((entry) => entry.id === 'duplicate_detection')?.severity).toBe('advisory');
    expect(check(content().checks).check).toBe('duplicate_detection');
  });

  it('asks content under the caller’s context, scoped to the proposal’s subject', async () => {
    const { checks, calls } = content();
    expectValue(await run8(checks));
    const [asked] = calls.duplicates as { subject: string; content: { provenance: { sourceType: string } } }[];
    expect(asked?.subject).toBe('physics');
    expect(asked?.content.provenance.sourceType).toBe('ai_generated');
  });

  it('passes when nothing close exists, saying so', async () => {
    const outcome = expectValue(await run8(content().checks));
    expect(outcome).toEqual({ outcome: 'pass', detail: 'no retype and no constants-swap of anything in physics' });
  });

  it('fails on an exact retype, naming it', async () => {
    const outcome = expectValue(await run8(content({ duplicates: { ...EMPTY_DUPLICATES, exactMatches: [entry('v-1')] } }).checks));
    expect(outcome).toEqual({ outcome: 'fail', detail: 'exact retype of v-1' });
  });

  it('fails on the same question with different constants, naming it', async () => {
    const outcome = expectValue(await run8(content({ duplicates: { ...EMPTY_DUPLICATES, skeletonMatches: [entry('v-2'), entry('v-3')] } }).checks));
    expect(outcome).toEqual({ outcome: 'fail', detail: 'same question with different constants as v-2, v-3' });
  });

  it('reports both when both, and the nearest neighbour beside them', async () => {
    const outcome = expectValue(
      await run8(content({ duplicates: { ...EMPTY_DUPLICATES, exactMatches: [entry('v-1')], skeletonMatches: [entry('v-1')], trigramMatches: [entry('v-4', 0.5), entry('v-5', 0.7)] } }).checks),
    );
    expect(outcome.outcome).toBe('fail');
    expect(outcome.detail).toBe('exact retype of v-1; same question with different constants as v-1; 2 merely similar, nearest at 0.70');
  });

  it('passes a merely similar neighbour: a ranked neighbourhood is retrieval, and a variant is welcome (ADR-0021)', async () => {
    const outcome = expectValue(await run8(content({ duplicates: { ...EMPTY_DUPLICATES, trigramMatches: [entry('v-4', 0.62), entry('v-5')] } }).checks));
    expect(outcome.outcome).toBe('pass');
    expect(outcome.detail).toBe('no retype and no constants-swap of anything in physics; 2 merely similar, nearest at 0.62');
  });

  it('cannot run when content refuses or fails — the refusal is content’s own, unchanged', async () => {
    const refused = applicationError('Authorization', 'NOT_PERMITTED', 'no');
    const checks: ContentProposalChecks = { validate: () => report(), duplicates: async () => err(refused) };
    expect(expectError(await run8(checks))).toBe(refused);
  });

  it('cannot run on a proposal that cannot be assembled', async () => {
    const { subject: _subject, ...noSubject } = BODY;
    expect(expectError(await run8(content().checks, candidate(noSubject))).code).toBe('PROPOSAL_FIELD_MISSING');
  });
});
