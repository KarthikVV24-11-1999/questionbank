import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * `/healthz` and `/readyz` are operational, not contract (M0-13) — asserted
 * against the real, committed documents rather than trusted by inspection.
 */
const DOCS = ['content.yaml', 'curriculum.yaml', 'scoring.yaml'];

describe('health routes are absent from every OpenAPI document', () => {
  it.each(DOCS)('%s names no /healthz or /readyz path', (fileName) => {
    const spec = parse(
      readFileSync(
        fileURLToPath(new URL(`../../../../../packages/contracts/openapi/${fileName}`, import.meta.url)),
        'utf8',
      ),
    ) as { readonly paths: Record<string, unknown> };

    expect(Object.keys(spec.paths)).not.toContain('/healthz');
    expect(Object.keys(spec.paths)).not.toContain('/readyz');
  });
});
