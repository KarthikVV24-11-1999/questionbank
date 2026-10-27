import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkSpecsServeOnLoopback } from './loopback-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('a spec that sends requests to an application starts it on loopback (M7-21, D73)', () => {
  it('holds across the specs: every one that reaches a Nest application\'s server serves it on 127.0.0.1', () => {
    expect(checkSpecsServeOnLoopback(API_ROOT, ['src'])).toEqual([]);
  });

  it('looked at the specs that make requests: the set, not whatever was found', () => {
    // the rule is about specs that call getHttpServer(); without them in view it would pass by looking at nothing
    const withoutTheHelper = checkSpecsServeOnLoopback(API_ROOT, ['src/testing', 'src/fitness-fixtures'], { onlySpecs: false });
    expect(withoutTheHelper.map((v) => v.file)).toEqual(['src/fitness-fixtures/as-loopback/planted-wildcard.ts']);
  });

  it('is red on a file that sends requests to an application it started with init()', () => {
    const found = checkSpecsServeOnLoopback(API_ROOT, ['src/fitness-fixtures/as-loopback'], { onlySpecs: false });
    expect(found).toEqual([{ rule: 'M7_21_SPEC_USES_A_WILDCARD_LISTENER', file: 'src/fitness-fixtures/as-loopback/planted-wildcard.ts' }]);
  });

  it('and green on the same request to an application bound to loopback first', () => {
    expect(checkSpecsServeOnLoopback(API_ROOT, ['src/fitness-fixtures/as-loopback'], { onlySpecs: false }).map((v) => v.file)).not.toContain('src/fitness-fixtures/as-loopback/permitted-loopback.ts');
  });
});
