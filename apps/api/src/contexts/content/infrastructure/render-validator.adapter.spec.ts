import { describe, expect, it } from 'vitest';
import { readCode, tsFilesUnder } from '../../../fitness/source-scan.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentBody } from '../domain/content-body.js';
import type { ItemVersion } from '../domain/item-version.js';
import { RenderValidatorAdapter } from './render-validator.adapter.js';

const ADAPTER_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'render-validator.adapter.ts');

function body(...blocks: ContentBody['blocks']): ContentBody {
  return { schemaVersion: 1, blocks };
}

function itemVersion(stem: ContentBody, versionId = 'iv-1'): ItemVersion {
  return {
    versionId,
    versionNo: 1,
    itemType: 'NUMERIC',
    stem,
    responseSpec: {
      itemType: 'NUMERIC',
      spec: { expectedValue: '4', comparisonMode: 'EXACT', acceptedForms: ['DECIMAL'] },
    },
    taxonomyTags: [{ conceptIdentityId: 'concept-1', taxonomyVersionId: 'tv-1', weight: 1, isPrimary: true }],
    difficultyEstimate: 'moderate',
    provenance: { sourceType: 'original' },
    licensing: { status: 'owned' },
    authoredBy: { kind: 'human', id: 'user-1', roleContext: ['author'] },
    createdAt: '2026-08-13T00:00:00.000Z',
  };
}

describe('RenderValidatorAdapter — closes D27', () => {
  it('a valid body validates on all four surfaces', async () => {
    const adapter = new RenderValidatorAdapter();
    const version = itemVersion(
      body({ kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: 'A block on a ramp.', marks: [] }] }),
    );
    const verdict = await adapter.validate(version);
    expect(verdict.itemVersionId).toBe('iv-1');
    expect(verdict.surfacesChecked).toEqual(['web', 'mobile', 'offline', 'print']);
    expect(verdict.failures).toEqual([]);
  });

  it('a body that fails one surface produces a blocking verdict naming it', async () => {
    const adapter = new RenderValidatorAdapter();
    // An unknown block kind fails rendering on every surface uniformly — the
    // renderer's own "unknown node" path, exercised through a real body.
    const version = itemVersion(body({ kind: 'WORMHOLE' } as unknown as ContentBody['blocks'][number]));
    const verdict = await adapter.validate(version);
    expect(verdict.failures.length).toBeGreaterThan(0);
    expect(verdict.failures.every((failure) => failure.includes('unknown block kind'))).toBe(true);
  });

  it('reports every surface checked, not a filtered subset', async () => {
    const adapter = new RenderValidatorAdapter();
    const version = itemVersion(body({ kind: 'MATH_BLOCK', latex: 'x^2', textAlternative: 'x squared' }));
    const verdict = await adapter.validate(version);
    expect(verdict.surfacesChecked).toHaveLength(4);
  });

  it('a media-unresolved issue does not block — it is a host condition, not a document defect', async () => {
    const adapter = new RenderValidatorAdapter();
    const version = itemVersion(
      body({ kind: 'PARAGRAPH', inlines: [{ kind: 'MEDIA_REF', assetVersionId: 'asset-1' }] }),
    );
    const verdict = await adapter.validate(version);
    expect(verdict.failures).toEqual([]);
  });
});

describe('RenderValidatorAdapter — delegates, and contains no JSX or element construction', () => {
  it('the adapter file is plain TypeScript, not TSX', () => {
    const files = tsFilesUnder(dirname(ADAPTER_FILE));
    expect(files).toContain(ADAPTER_FILE);
  });

  it('declares no JSX syntax and constructs no React element', () => {
    const code = readCode(ADAPTER_FILE);
    // A JSX tag's `<` is never preceded by a word character — that shape
    // (`Promise<RenderVerdict>`) is a generic, not a tag, and the lookbehind
    // is what keeps this from flagging the adapter's own return type.
    expect(code).not.toMatch(/(?<![\w])<[A-Za-z][\w.]*[\s/>]/u);
    expect(code).not.toContain('React.createElement');
    expect(code).not.toContain('ContentRenderer(');
    expect(code).not.toContain("from 'react'");
    expect(code).not.toContain('from "react"');
  });

  it('imports validateRender and calls it exactly once per invocation, doing nothing else with the renderer', () => {
    const code = readCode(ADAPTER_FILE);
    expect(code).toContain("from '@questionbank/content-renderer/render-validation'");
    const callSites = code.match(/validateRender\(/gu) ?? [];
    expect(callSites).toHaveLength(1);
  });
});
