// Planted violation for content-rules.spec.ts's "ReviewProgress exists
// nowhere in the tree" check (M4-30) — proves the check can fail. Never
// imported by production code.
export interface ReviewProgress {
  hasBegun(itemVersionId: string): Promise<boolean>;
}
