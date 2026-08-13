#!/usr/bin/env node
/**
 * Generates Zod request/response schemas from an OpenAPI document.
 *
 * **Written rather than installed** because the repository has no network and
 * no generator on disk, and D18's point is not which tool runs — it is that
 * the schemas are *derived from the document* rather than typed a second time
 * beside it. Two hand-maintained descriptions of one contract drift, and the
 * drift shows up as a request the boundary accepts and the handler cannot use.
 *
 * The subset covered is the subset the content document uses: objects with
 * `required`/`properties`/`additionalProperties: false`, arrays, `$ref`,
 * enums, and the five scalar types. A construct outside that subset throws, so
 * the generator fails loudly rather than emitting something permissive.
 *
 *   node scripts/generate-zod.mjs openapi/content.yaml src/content-schemas.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from 'yaml';

const [, , input, output] = process.argv;
if (input === undefined || output === undefined) {
  console.error('usage: generate-zod.mjs <openapi.yaml> <output.ts>');
  process.exit(1);
}

const document = parse(readFileSync(input, 'utf8'));
const schemas = document.components?.schemas ?? {};

function refName(ref) {
  const match = /^#\/components\/schemas\/(.+)$/u.exec(ref);
  if (match === null) throw new Error(`unsupported $ref: ${ref}`);
  return match[1];
}

function render(schema, indent) {
  const pad = ' '.repeat(indent);

  if (schema.$ref !== undefined) return `${refName(schema.$ref)}Schema`;

  if (Array.isArray(schema.enum)) {
    const members = schema.enum.map((value) => JSON.stringify(String(value))).join(', ');
    return `z.enum([${members}])`;
  }

  switch (schema.type) {
    case 'string':
      return 'z.string()';
    case 'integer':
      return 'z.number().int()';
    case 'number':
      return 'z.number()';
    case 'boolean':
      return 'z.boolean()';
    case 'array':
      if (schema.items === undefined) throw new Error('an array schema needs items');
      return `z.array(${render(schema.items, indent)})`;
    case 'object': {
      const properties = schema.properties ?? {};
      const names = Object.keys(properties);
      if (names.length === 0) return 'z.record(z.string(), z.unknown())';
      const required = new Set(schema.required ?? []);
      const lines = names.map((name) => {
        const rendered = render(properties[name], indent + 2);
        const suffix = required.has(name) ? '' : '.optional()';
        return `${pad}  ${JSON.stringify(name)}: ${rendered}${suffix},`;
      });
      const object = [`z.object({`, ...lines, `${pad}})`].join('\n');
      // `additionalProperties: false` is the document's default here, and it
      // is the whole reason a request schema is worth having: an unexpected
      // field is a client sending something the contract never promised.
      return schema.additionalProperties === false ? `${object}.strict()` : object;
    }
    default:
      throw new Error(`unsupported schema type: ${JSON.stringify(schema.type)}`);
  }
}

/** Emits definitions in dependency order, so no forward reference is needed. */
function order(names) {
  const emitted = [];
  const seen = new Set();

  const visit = (name, stack) => {
    if (seen.has(name)) return;
    if (stack.includes(name)) throw new Error(`cyclic schema reference: ${[...stack, name].join(' -> ')}`);
    const schema = schemas[name];
    if (schema === undefined) throw new Error(`unknown schema: ${name}`);
    for (const dependency of referencesOf(schema)) visit(dependency, [...stack, name]);
    seen.add(name);
    emitted.push(name);
  };

  for (const name of names) visit(name, []);
  return emitted;
}

function referencesOf(node) {
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(referencesOf);
  const found = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') found.push(refName(value));
    else found.push(...referencesOf(value));
  }
  return found;
}

const header = `// GENERATED FILE — do not edit.
//
// Produced by \`scripts/generate-zod.mjs\` from \`openapi/${basename(input)}\`, which is the source
// of truth (BACKEND-ARCHITECTURE §3, closing D18 for this context). The
// contract spec regenerates it and fails on any difference, so an edit here is
// caught rather than merged.
//
// Regenerate with: pnpm --filter @questionbank/contracts run generate:content

import { z } from 'zod';
`;

const body = order(Object.keys(schemas))
  .map((name) => `export const ${name}Schema = ${render(schemas[name], 0)};\n\nexport type ${name} = z.infer<typeof ${name}Schema>;`)
  .join('\n\n');

writeFileSync(output, `${header}\n${body}\n`);
console.log(`wrote ${output} (${Object.keys(schemas).length} schemas)`);
