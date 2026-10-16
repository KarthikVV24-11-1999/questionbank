import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthoredItemContent } from '../../content/public/index.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { aCandidate, aRun } from '../../../testing/generation-fixtures.js';
import { MODEL_PIN_FIELDS } from '../domain/model-pin.js';
import type { GenerationCandidate } from '../domain/generation-candidate.js';
import { PIN_TO_PROVENANCE, PROPOSAL_REQUIRED_KEYS, toAiProvenance, toContentDraft } from './content-draft-acl.js';

const PROPOSAL = {
  stem: { blocks: ['a stem'] },
  responseSpec: { itemType: 'SINGLE_CORRECT_MCQ', correctOptionId: 'a' },
  taxonomyTags: [{ conceptIdentityId: 'c', taxonomyVersionId: 't', weight: 1, isPrimary: true }],
  difficultyEstimate: 'moderate',
  subject: 'physics',
  licensing: { status: 'owned' },
  stimulusVersionRef: 'stim-v1',
};

const uuidRun = () => aRun({ modelVersionId: randomUUID(), promptVersionId: randomUUID() });

function candidate(overrides: { body?: Record<string, unknown>; confidence?: number } = {}): GenerationCandidate {
  return aCandidate(uuidRun(), { body: overrides.body ?? PROPOSAL, confidence: overrides.confidence ?? 0.82 });
}

/** A candidate that never went through construction, as one read back from storage might not have. */
function forged(patch: Partial<GenerationCandidate>): GenerationCandidate {
  return { ...candidate(), ...patch } as GenerationCandidate;
}

describe('the pin and content’s provenance — parity, field by field', () => {
  // Not `toEqual` over two shapes that could each be missing the same field
  // (ADR-0017): every member of the pin is looked up by name on both sides.
  it('maps every member of the pin, and the rename is the only one', () => {
    expect([...MODEL_PIN_FIELDS].sort()).toEqual(Object.keys(PIN_TO_PROVENANCE).sort());
    expect(PIN_TO_PROVENANCE.modelVersionId).toBe('modelVersionId');
    expect(PIN_TO_PROVENANCE.promptVersionId).toBe('promptVersionId');
    expect(PIN_TO_PROVENANCE.runId).toBe('generationRunId');
  });

  it('carries each member of the pin into the field content names for it', () => {
    const source = candidate();
    const provenance = expectValue(toAiProvenance(source));

    expect(provenance.sourceType).toBe('ai_generated');
    expect(provenance.modelVersionId).toBe(source.pin.modelVersionId);
    expect(provenance.promptVersionId).toBe(source.pin.promptVersionId);
    expect(provenance.generationRunId).toBe(source.pin.runId);
    expect(provenance.confidence).toBe(0.82);
    expect(Object.keys(provenance).sort()).toEqual(
      ['confidence', 'generationRunId', 'modelVersionId', 'promptVersionId', 'sourceType'],
    );
  });

  it('carries distinct values, so a swapped pair of fields cannot hide behind equal ones', () => {
    const run = uuidRun();
    const provenance = expectValue(toAiProvenance(aCandidate(run, { confidence: 0.3 })));
    expect(provenance.modelVersionId).toBe(run.pin.modelVersionId);
    expect(provenance.promptVersionId).toBe(run.pin.promptVersionId);
    expect(provenance.generationRunId).toBe(run.pin.runId);
    expect(new Set([provenance.modelVersionId, provenance.promptVersionId, provenance.generationRunId]).size).toBe(3);
    expect(provenance.confidence).toBe(0.3);
  });

  it('names no field content does not have: a runId key never reaches provenance', () => {
    const provenance = expectValue(toAiProvenance(candidate())) as unknown as Record<string, unknown>;
    expect(Object.hasOwn(provenance, 'runId')).toBe(false);
  });

  it('rounds confidence to the three places content stores, and leaves the candidate’s own figure alone', () => {
    const source = candidate({ confidence: 0.82349 });
    expect(expectValue(toAiProvenance(source)).confidence).toBe(0.823);
    expect(source.confidence).toBe(0.82349);
    expect(expectValue(toAiProvenance(candidate({ confidence: 0.8235 }))).confidence).toBe(0.824);
    expect(expectValue(toAiProvenance(candidate({ confidence: 0.9996 }))).confidence).toBe(1);
  });

  it('keeps the boundary confidences 0 and 1', () => {
    expect(expectValue(toAiProvenance(candidate({ confidence: 0 }))).confidence).toBe(0);
    expect(expectValue(toAiProvenance(candidate({ confidence: 1 }))).confidence).toBe(1);
  });
});

describe('a candidate content’s provenance would refuse is refused here, naming the field', () => {
  it.each([
    ['modelVersionId', 'modelVersionId'],
    ['promptVersionId', 'promptVersionId'],
    ['runId', 'generationRunId'],
  ] as const)('a blank pin.%s is refused as %s', (member, field) => {
    for (const blank of ['', '   ', undefined]) {
      const source = candidate();
      const failure = expectError(toAiProvenance(forged({ pin: { ...source.pin, [member]: blank } as never })));
      expect(failure.kind).toBe('PreconditionFailed');
      expect(failure.code).toBe('PROVENANCE_FIELD_BLANK');
      expect(failure.location).toBe(`provenance.${field}`);
      expect(failure.message).toContain(field);
      expect(failure.message).toContain(`pin.${member}`);
    }
  });

  it.each([
    ['modelVersionId', 'modelVersionId'],
    ['promptVersionId', 'promptVersionId'],
    ['runId', 'generationRunId'],
  ] as const)('a pin.%s that is a label and not a UUID is refused as %s — content stores it as one', (member, field) => {
    for (const label of ['model-v3', 'run-42', '1234', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', `${randomUUID()}x`]) {
      const source = candidate();
      const failure = expectError(toAiProvenance(forged({ pin: { ...source.pin, [member]: label } })));
      expect(failure.kind).toBe('PreconditionFailed');
      expect(failure.code).toBe('PROVENANCE_FIELD_NOT_A_UUID');
      expect(failure.location).toBe(`provenance.${field}`);
      expect(failure.message).toContain(label);
    }
  });

  it('accepts a UUID in either case', () => {
    const source = candidate();
    const upper = { ...source.pin, runId: source.pin.runId.toUpperCase() };
    expectValue(toAiProvenance(forged({ pin: upper })));
  });

  it('a candidate with no confidence', () => {
    for (const confidence of [undefined, null, '0.5']) {
      const failure = expectError(toAiProvenance(forged({ confidence: confidence as never })));
      expect(failure.code).toBe('PROVENANCE_CONFIDENCE_MISSING');
      expect(failure.location).toBe('provenance.confidence');
    }
  });

  it('a confidence outside [0, 1], including NaN and infinity', () => {
    for (const confidence of [-0.1, 1.1, Number.NaN, Infinity, -Infinity]) {
      const failure = expectError(toAiProvenance(forged({ confidence })));
      expect(failure.code, String(confidence)).toBe('PROVENANCE_CONFIDENCE_OUT_OF_RANGE');
      expect(failure.location).toBe('provenance.confidence');
    }
  });

  it('reports the first problem in a fixed order: model, prompt, run, then confidence', () => {
    const source = candidate();
    const failure = expectError(
      toAiProvenance(forged({ pin: { modelVersionId: '', promptVersionId: '', runId: '' }, confidence: 7 })),
    );
    expect(failure.location).toBe('provenance.modelVersionId');
    expect(source.pin.runId).not.toBe('');
  });
});

describe('the draft command', () => {
  it('assembles the command from the proposal, with provenance built here and not read from the body', () => {
    const source = candidate();
    const draft = expectValue(toContentDraft(source));

    expect(draft.itemType).toBe('SINGLE_CORRECT_MCQ');
    expect(draft.subject).toBe('physics');
    const content: AuthoredItemContent = draft.content;
    expect(content.stem).toBe(source.content.body['stem']);
    expect(content.responseSpec).toBe(source.content.body['responseSpec']);
    expect(content.taxonomyTags).toBe(source.content.body['taxonomyTags']);
    expect(content.difficultyEstimate).toBe('moderate');
    expect(content.licensing).toEqual({ status: 'owned' });
    expect(content.stimulusVersionRef).toBe('stim-v1');
    expect(content.provenance.sourceType).toBe('ai_generated');
    expect(content.provenance.generationRunId).toBe(source.pin.runId);
    expect(Object.keys(content).sort()).toEqual(
      ['difficultyEstimate', 'licensing', 'provenance', 'responseSpec', 'stem', 'stimulusVersionRef', 'taxonomyTags'],
    );
  });

  it('ignores a provenance the body tries to carry — the pin is the only source', () => {
    const lying = { ...PROPOSAL, provenance: { sourceType: 'original', authorRef: 'someone' } };
    const draft = expectValue(toContentDraft(candidate({ body: lying })));
    expect(draft.content.provenance.sourceType).toBe('ai_generated');
    expect(draft.content.provenance.authorRef).toBeUndefined();
  });

  it('omits licensing and the stimulus reference when the proposal has none', () => {
    const { licensing: _l, stimulusVersionRef: _s, ...bare } = PROPOSAL;
    const draft = expectValue(toContentDraft(candidate({ body: bare })));
    expect(Object.hasOwn(draft.content, 'licensing')).toBe(false);
    expect(Object.hasOwn(draft.content, 'stimulusVersionRef')).toBe(false);
  });

  it.each(PROPOSAL_REQUIRED_KEYS)('refuses a proposal without "%s", naming it', (key) => {
    const { [key]: _omitted, ...rest } = PROPOSAL;
    const failure = expectError(toContentDraft(candidate({ body: rest })));
    expect(failure.kind).toBe('Validation');
    expect(failure.code).toBe('PROPOSAL_FIELD_MISSING');
    expect(failure.location).toBe(`content.body.${key}`);
  });

  it('refuses a blank subject', () => {
    for (const subject of ['', '  ', 4]) {
      const failure = expectError(toContentDraft(candidate({ body: { ...PROPOSAL, subject } })));
      expect(failure.code).toBe('PROPOSAL_FIELD_MISSING');
      expect(failure.location).toBe('content.body.subject');
    }
  });

  it('puts a provenance problem before a proposal problem', () => {
    const failure = expectError(toContentDraft(forged({ confidence: 9, content: { itemType: 'X', body: {} } })));
    expect(failure.code).toBe('PROVENANCE_CONFIDENCE_OUT_OF_RANGE');
  });
});
