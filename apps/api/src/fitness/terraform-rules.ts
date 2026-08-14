import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A **lint**, not a validation (DEC-M0-11, ADR-0013). There is no HCL parser
 * and no AWS provider plugin in this environment's offline store, so this
 * scans the text of every `.tf` file rather than parsing it — what it proves
 * is exactly what a text scan can honestly prove, nothing about whether
 * `terraform plan` would succeed. The Tier-3 successor, verbatim:
 *
 *   terraform init && terraform validate && terraform plan -var-file=staging.tfvars
 */

export interface TerraformViolation {
  readonly rule: string;
  readonly detail: string;
}

const SECRET_LITERAL_PATTERNS = [
  /AKIA[0-9A-Z]{16}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(password|secret|token)\s*=\s*"(?!.*REPLACE_ME)[^$"]{6,}"/iu,
];

function readTfFiles(directory: string): readonly { readonly path: string; readonly source: string }[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.tf'))
    .map((name) => ({ path: join(directory, name), source: readFileSync(join(directory, name), 'utf8') }));
}

/** Every top-level `resource "type" "name" { ... }` block, brace-matched. */
function resourceBlocks(source: string): readonly { readonly type: string; readonly body: string }[] {
  const blocks: { type: string; body: string }[] = [];
  const pattern = /resource\s+"([^"]+)"\s+"[^"]+"\s*\{/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const type = match[1]!;
    let depth = 1;
    let index = pattern.lastIndex;
    const start = index;
    while (depth > 0 && index < source.length) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}') depth -= 1;
      index += 1;
    }
    blocks.push({ type, body: source.slice(start, index - 1) });
  }
  return blocks;
}

export function checkTerraform(directory: string): { readonly violations: TerraformViolation[]; readonly scannedFiles: number } {
  const files = readTfFiles(directory);
  const violations: TerraformViolation[] = [];
  const wholeSource = files.map((f) => f.source).join('\n');

  const allBlocks = files.flatMap((f) => resourceBlocks(f.source).map((b) => ({ ...b, file: f.path })));

  for (const block of allBlocks) {
    const tagged = /tags\s*=\s*local\.tags/u.test(block.body) || /Environment\s*=\s*"staging"/u.test(block.body);
    if (!tagged) {
      violations.push({ rule: 'UNTAGGED_RESOURCE', detail: `${block.type} in ${block.file}` });
    }
  }

  for (const file of files) {
    for (const pattern of SECRET_LITERAL_PATTERNS) {
      if (pattern.test(file.source)) {
        violations.push({ rule: 'SECRET_LITERAL', detail: file.path });
      }
    }
  }

  const regionVariable = /variable\s+"region"\s*\{[^}]*default\s*=\s*"([^"]+)"/u.exec(wholeSource);
  if (regionVariable === null || regionVariable[1] !== 'ap-south-1') {
    violations.push({ rule: 'REGION_NOT_AP_SOUTH_1', detail: regionVariable?.[1] ?? '(no default)' });
  }

  const dbInstances = allBlocks.filter((b) => b.type === 'aws_db_instance');
  for (const db of dbInstances) {
    const engineMatch = /engine\s*=\s*"([^"]+)"/u.exec(db.body);
    if (engineMatch?.[1] !== 'postgres') {
      violations.push({ rule: 'DB_ENGINE_NOT_POSTGRES', detail: engineMatch?.[1] ?? '(none)' });
    }
  }
  if (/aurora/iu.test(wholeSource)) {
    violations.push({ rule: 'AURORA_MENTIONED', detail: 'TECH-STACK §3: moving off Aurora is the one-way door' });
  }

  if (!/backend\s+"s3"|backend\s+"remote"|backend\s+"azurerm"|backend\s+"gcs"/u.test(wholeSource)) {
    violations.push({ rule: 'NO_NON_LOCAL_BACKEND', detail: 'no non-local state backend declared' });
  }
  if (/backend\s+"local"/u.test(wholeSource)) {
    violations.push({ rule: 'LOCAL_BACKEND', detail: 'state backend is local' });
  }

  return { violations, scannedFiles: files.length };
}
