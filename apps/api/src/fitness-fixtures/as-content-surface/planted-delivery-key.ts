/**
 * A planted F6/F35 violation: a module treated as a **delivery** payload
 * surface that names the answer key. `content-rules.spec.ts` points
 * `checkPayloadSurfaces` at this file to prove the amended rule still fires —
 * ADR-0009 widened where a key may live, and a widened rule that nobody has
 * seen fail is indistinguishable from a deleted one.
 */
export interface PlantedDeliveryItemDto {
  readonly itemVersionId: string;
  readonly correctOptionId: string;
  readonly expectedValue: string;
}
