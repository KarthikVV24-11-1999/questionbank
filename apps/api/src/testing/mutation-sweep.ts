/**
 * Single-point malformation, enumerated rather than sampled.
 *
 * A model's proposal is untyped JSON, and the shapes it produces are not the
 * shapes TypeScript was checking (debt D41). To say a function is *total* over
 * such input — that it returns a value however the input is broken — is a claim
 * about every way an input can be broken, and a handful of hand-picked bad
 * inputs does not make it. So this takes a valid document and breaks it at every
 * position it has, in every way a JSON value can be wrong, one position at a
 * time. It is deterministic: the same document yields the same mutations in the
 * same order, on every machine.
 *
 * Breaking a position means: remove it, or replace it with `null`, a number, a
 * string, an empty array or an empty object. Those six cover "absent", "null",
 * and each of the JSON types in the wrong place.
 */

export type Path = readonly (string | number)[];

export const MALFORMATIONS = ['removed', 'null', 'number', 'string', 'empty array', 'empty object'] as const;
export type Malformation = (typeof MALFORMATIONS)[number];

const REPLACEMENT: Readonly<Record<Exclude<Malformation, 'removed'>, unknown>> = {
  null: null,
  number: 7,
  string: 'x',
  'empty array': [],
  'empty object': {},
};

/** Every position in a JSON document, the root first. */
export function pathsOf(document: unknown): Path[] {
  const paths: Path[] = [];
  const walk = (value: unknown, path: Path): void => {
    paths.push(path);
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...path, index]));
    else if (typeof value === 'object' && value !== null) {
      for (const [key, inner] of Object.entries(value)) walk(inner, [...path, key]);
    }
  };
  walk(document, []);
  return paths;
}

/** A copy of `document` with one position broken. The root can only be replaced. */
export function mutate(document: unknown, path: Path, how: Malformation): unknown {
  const copy = JSON.parse(JSON.stringify(document)) as unknown;
  if (path.length === 0) return how === 'removed' ? undefined : REPLACEMENT[how];

  let parent = copy as Record<string | number, unknown>;
  for (const step of path.slice(0, -1)) parent = parent[step] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;

  if (how !== 'removed') parent[last] = REPLACEMENT[how];
  else if (Array.isArray(parent)) parent.splice(last as number, 1);
  else delete parent[last];
  return copy;
}

export interface SweepResult {
  /** How many malformed documents were tried. */
  readonly tried: number;
  /** Those the function raised on, with where and how the document was broken. */
  readonly raised: readonly { readonly path: string; readonly how: Malformation; readonly message: string }[];
}

/** Runs `attempt` on every single-point malformation of `document`, recording each one it raises on. */
export function sweep(document: unknown, attempt: (mutated: unknown) => void): SweepResult {
  const raised: { path: string; how: Malformation; message: string }[] = [];
  let tried = 0;
  for (const path of pathsOf(document)) {
    for (const how of MALFORMATIONS) {
      tried += 1;
      try {
        attempt(mutate(document, path, how));
      } catch (error) {
        raised.push({ path: path.join('.') || '(root)', how, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { tried, raised };
}
