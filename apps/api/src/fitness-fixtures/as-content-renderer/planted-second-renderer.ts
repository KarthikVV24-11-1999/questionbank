/**
 * A planted F20 violation: a second `ContentRenderer`. Two implementations
 * mean the authoring preview diverges from what students see, silently, and
 * INV-14's byte-for-byte promise becomes a claim nobody can check — so the
 * scan is shown to find this one before it is trusted to find none.
 */
export function ContentRenderer(): string {
  return 'a second implementation';
}
