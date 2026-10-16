/**
 * What a constructor may assume about a value it was handed, and how it finds
 * out cheaply that it may not.
 *
 * Content's constructors are typed, and a typed caller cannot hand them a
 * `null` where an array belongs. A model's proposal is not typed (debt D41): it
 * is JSON, and the shapes a model produces are not the shapes TypeScript was
 * checking. These are the checks that let a constructor answer "this is not the
 * shape of an X" with a value instead of dereferencing it and raising.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

/** A string with something in it. Anything that is not a string is as blank as an empty one. */
export function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}
