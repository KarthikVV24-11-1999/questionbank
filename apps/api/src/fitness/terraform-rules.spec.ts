import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkTerraform } from './terraform-rules.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const STAGING_DIR = resolve(REPO_ROOT, 'infra/terraform/staging');
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../fitness-fixtures');

describe('the real staging Terraform — a lint, not a validation', () => {
  it('scans a non-zero number of .tf files', () => {
    expect(checkTerraform(STAGING_DIR).scannedFiles).toBeGreaterThan(0);
  });

  it('passes every check', () => {
    expect(checkTerraform(STAGING_DIR).violations).toEqual([]);
  });
});

describe('planted violations — one per assertion', () => {
  it('an untagged resource is a violation', () => {
    const { violations } = checkTerraform(resolve(FIXTURES, 'as-terraform-untagged'));
    expect(violations.some((v) => v.rule === 'UNTAGGED_RESOURCE')).toBe(true);
  });

  it('a literal secret is a violation', () => {
    const { violations } = checkTerraform(resolve(FIXTURES, 'as-terraform-secret'));
    expect(violations.some((v) => v.rule === 'SECRET_LITERAL')).toBe(true);
  });

  it('a hardcoded, non-ap-south-1 region default is a violation', () => {
    const { violations } = checkTerraform(resolve(FIXTURES, 'as-terraform-region'));
    expect(violations.some((v) => v.rule === 'REGION_NOT_AP_SOUTH_1')).toBe(true);
  });

  it('an Aurora engine is a violation', () => {
    const { violations } = checkTerraform(resolve(FIXTURES, 'as-terraform-aurora'));
    expect(violations.some((v) => v.rule === 'AURORA_MENTIONED')).toBe(true);
  });

  it('a local state backend is a violation', () => {
    const { violations } = checkTerraform(resolve(FIXTURES, 'as-terraform-local-backend'));
    expect(violations.some((v) => v.rule === 'LOCAL_BACKEND')).toBe(true);
  });
});

describe('the successor command this lint cannot run itself', () => {
  it('is named verbatim in variables.tf', () => {
    const source = readFileSync(resolve(STAGING_DIR, 'variables.tf'), 'utf8');
    expect(source).toContain('terraform init && terraform validate && terraform plan -var-file=staging.tfvars');
  });

  it("the module's own header states this is a lint, not a validation", () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'terraform-rules.ts'), 'utf8');
    expect(source).toMatch(/lint.{0,20}not a validation/iu);
  });
});
