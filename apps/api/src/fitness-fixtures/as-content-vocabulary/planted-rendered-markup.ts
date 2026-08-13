/**
 * A planted INV-14 violation: a node vocabulary that can carry rendered markup
 * and an image of text. `ContentBody` is structured markup — never rendered
 * markup, never an image of text (DOMAIN-MODEL §5) — and a field like this is
 * how the second one arrives.
 */
export interface PlantedNode {
  readonly kind: 'PARAGRAPH';
  readonly html: string;
  readonly svg?: string;
}
