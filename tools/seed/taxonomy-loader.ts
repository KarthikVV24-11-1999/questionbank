import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import { parseDocument, type Document } from 'yaml';
import { ConceptIdentity } from '../../apps/api/src/contexts/curriculum/domain/concept-identity.js';
import { ConceptNode } from '../../apps/api/src/contexts/curriculum/domain/concept-node.js';
import { PrerequisiteEdge } from '../../apps/api/src/contexts/curriculum/domain/prerequisite-edge.js';
import { TaxonomyVersion } from '../../apps/api/src/contexts/curriculum/domain/taxonomy-version.js';
import type {
  ConceptIdentityRepository,
  TaxonomyVersionRepository,
} from '../../apps/api/src/contexts/curriculum/domain/repository-ports.js';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema/taxonomy.schema.json');

export interface TaxonomyFileConcept {
  readonly key: string;
  readonly displayName: string;
  readonly canonicalName?: string;
  readonly examWeight?: number;
  readonly estimatedTeachingHours?: number;
  readonly children?: readonly TaxonomyFileConcept[];
}

export interface TaxonomyFile {
  readonly schemaVersion: number;
  readonly examFamily: string;
  readonly academicYear: string;
  readonly subjects: ReadonlyArray<{ readonly subjectDomain: string; readonly root: TaxonomyFileConcept }>;
  readonly prerequisites?: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly strength?: number;
  }>;
}

/** A problem with one record, located precisely enough to fix it. */
export interface LoadIssue {
  readonly path: string;
  readonly line: number | null;
  readonly message: string;
}

export interface LoadReport {
  readonly taxonomyVersionId: string;
  readonly conceptCount: number;
  readonly prerequisiteCount: number;
  /** True when the file was already loaded and nothing changed. */
  readonly unchanged: boolean;
}

export type LoadOutcome =
  | { readonly ok: true; readonly report: LoadReport }
  | { readonly ok: false; readonly issues: readonly LoadIssue[] };

export interface LoaderDependencies {
  readonly versions: TaxonomyVersionRepository;
  readonly identities: ConceptIdentityRepository;
  /** Supplies ids so a re-run of the same file reuses them (idempotency). */
  readonly identifierFor: (kind: 'version' | 'concept' | 'node', key: string) => string;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateFile = ajv.compile<TaxonomyFile>(
  JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>,
);

function lineOf(document: Document, path: readonly (string | number)[]): number | null {
  const node = document.getIn(path, true) as { range?: [number, number, number] } | undefined;
  if (node?.range === undefined) return null;

  const source = String(document.contents === null ? '' : document.toString());
  return source.slice(0, node.range[0]).split('\n').length;
}

function toIssue(document: Document, error: ErrorObject): LoadIssue {
  const path = error.instancePath === '' ? '(root)' : error.instancePath;
  const segments = error.instancePath
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => (/^\d+$/u.test(segment) ? Number(segment) : segment));

  return {
    path,
    line: lineOf(document, segments),
    message: `${error.message ?? 'is invalid'}${
      error.params['additionalProperty'] !== undefined
        ? `: ${String(error.params['additionalProperty'])}`
        : ''
    }`,
  };
}

function flatten(
  concept: TaxonomyFileConcept,
  subjectDomain: string,
  parentKey: string | null,
  found: Array<{ concept: TaxonomyFileConcept; subjectDomain: string; parentKey: string | null }> = [],
): Array<{ concept: TaxonomyFileConcept; subjectDomain: string; parentKey: string | null }> {
  found.push({ concept, subjectDomain, parentKey });
  for (const child of concept.children ?? []) flatten(child, subjectDomain, concept.key, found);
  return found;
}

/** Structural checks the JSON Schema cannot express. */
function semanticIssues(file: TaxonomyFile): LoadIssue[] {
  const issues: LoadIssue[] = [];
  const all = file.subjects.flatMap((subject) => flatten(subject.root, subject.subjectDomain, null));
  const keys = all.map((entry) => entry.concept.key);

  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      issues.push({ path: `/subjects`, line: null, message: `concept key ${key} is used more than once` });
    }
    seen.add(key);
  }

  for (const edge of file.prerequisites ?? []) {
    for (const endpoint of [edge.from, edge.to]) {
      if (!seen.has(endpoint)) {
        issues.push({
          path: '/prerequisites',
          line: null,
          message: `prerequisite references unknown concept ${endpoint}`,
        });
      }
    }
    if (edge.from === edge.to) {
      issues.push({
        path: '/prerequisites',
        line: null,
        message: `concept ${edge.from} cannot be a prerequisite of itself`,
      });
    }
  }

  return issues;
}

export function parseTaxonomyFile(
  contents: string,
): { ok: true; file: TaxonomyFile } | { ok: false; issues: readonly LoadIssue[] } {
  const document = parseDocument(contents);
  if (document.errors.length > 0) {
    return {
      ok: false,
      issues: document.errors.map((error) => ({
        path: '(document)',
        line: contents.slice(0, error.pos[0]).split('\n').length,
        message: error.message,
      })),
    };
  }

  const parsed = document.toJS() as TaxonomyFile;
  if (!validateFile(parsed)) {
    const issues = (validateFile.errors ?? []).map((error) => toIssue(document, error));
    return { ok: false, issues };
  }

  const semantic = semanticIssues(parsed);
  return semantic.length > 0 ? { ok: false, issues: semantic } : { ok: true, file: parsed };
}

/**
 * Loads a taxonomy file into a draft version. The whole file is validated
 * before anything is written, and the version is left as a draft — publication
 * is a separate, governed act (M1-04).
 *
 * Re-running the same file is a no-op: identifiers are derived from concept
 * keys, so the second run finds the version already present and changes nothing.
 */
export async function loadTaxonomyFile(
  contents: string,
  deps: LoaderDependencies,
): Promise<LoadOutcome> {
  const parsed = parseTaxonomyFile(contents);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };

  const file = parsed.file;
  const taxonomyVersionId = deps.identifierFor('version', `${file.examFamily}:${file.academicYear}`);

  const existing = await deps.versions.findById(taxonomyVersionId);
  if (existing.ok) {
    return {
      ok: true,
      report: {
        taxonomyVersionId,
        conceptCount: existing.value.aggregate.nodes.length,
        prerequisiteCount: existing.value.aggregate.prerequisites.length,
        unchanged: true,
      },
    };
  }

  const draft = TaxonomyVersion.createDraft({
    taxonomyVersionId,
    examFamily: file.examFamily,
    academicYear: file.academicYear,
  });
  if (!draft.ok) {
    return { ok: false, issues: [{ path: '(root)', line: null, message: draft.error.message }] };
  }

  const inserted = await deps.versions.insert(draft.value);
  if (!inserted.ok) {
    return { ok: false, issues: [{ path: '(root)', line: null, message: inserted.error.message }] };
  }

  const built = await buildVersion(file, draft.value, deps);
  if (!built.ok) return built;

  const saved = await deps.versions.update(built.version, 1);
  if (!saved.ok) {
    return { ok: false, issues: [{ path: '(root)', line: null, message: saved.error.message }] };
  }

  return {
    ok: true,
    report: {
      taxonomyVersionId,
      conceptCount: built.version.nodes.length,
      prerequisiteCount: built.version.prerequisites.length,
      unchanged: false,
    },
  };
}

async function buildVersion(
  file: TaxonomyFile,
  draft: TaxonomyVersion,
  deps: LoaderDependencies,
): Promise<{ ok: true; version: TaxonomyVersion } | { ok: false; issues: readonly LoadIssue[] }> {
  let version = draft;
  const nodeByKey = new Map<string, ConceptNode>();
  const conceptIdByKey = new Map<string, string>();

  for (const subject of file.subjects) {
    for (const entry of flatten(subject.root, subject.subjectDomain, null)) {
      const conceptIdentityId = deps.identifierFor('concept', entry.concept.key);
      const identity = ConceptIdentity.create({
        conceptIdentityId,
        canonicalName: entry.concept.canonicalName ?? entry.concept.displayName,
        subjectDomain: entry.subjectDomain,
        createdInVersion: draft.taxonomyVersionId,
      });
      if (!identity.ok) {
        return { ok: false, issues: [issueFor(entry.concept.key, identity.error.message)] };
      }

      const storedIdentity = await deps.identities.insert(identity.value);
      if (!storedIdentity.ok) {
        return { ok: false, issues: [issueFor(entry.concept.key, storedIdentity.error.message)] };
      }
      conceptIdByKey.set(entry.concept.key, conceptIdentityId);

      const props = {
        conceptNodeId: deps.identifierFor('node', entry.concept.key),
        conceptIdentityId,
        displayName: entry.concept.displayName,
        examWeight: entry.concept.examWeight ?? 0,
        estimatedTeachingHours: entry.concept.estimatedTeachingHours ?? 0,
      };

      const parent = entry.parentKey === null ? undefined : nodeByKey.get(entry.parentKey);
      const node = parent === undefined ? ConceptNode.createRoot(props) : ConceptNode.createUnder(parent, props);
      if (!node.ok) return { ok: false, issues: [issueFor(entry.concept.key, node.error.message)] };

      const placed = version.addConceptNode(node.value, identity.value);
      if (!placed.ok) return { ok: false, issues: [issueFor(entry.concept.key, placed.error.message)] };

      version = placed.value;
      nodeByKey.set(entry.concept.key, node.value);
    }
  }

  for (const edge of file.prerequisites ?? []) {
    const created = PrerequisiteEdge.create({
      fromConceptIdentityId: conceptIdByKey.get(edge.from) ?? edge.from,
      toConceptIdentityId: conceptIdByKey.get(edge.to) ?? edge.to,
      strength: edge.strength ?? 0.5,
    });
    if (!created.ok) {
      return { ok: false, issues: [issueFor(`${edge.from}→${edge.to}`, created.error.message)] };
    }

    const added = version.addPrerequisiteEdge(created.value);
    if (!added.ok) {
      return { ok: false, issues: [issueFor(`${edge.from}→${edge.to}`, added.error.message)] };
    }
    version = added.value;
  }

  return { ok: true, version };
}

function issueFor(key: string, message: string): LoadIssue {
  return { path: `/concepts/${key}`, line: null, message };
}
