// Planted violation for frontend-rules.spec.ts (F24): a CSS named colour in
// a style-property context, not a bare word in prose.
export function errorStyle(): string {
  return "color: 'crimson'";
}
