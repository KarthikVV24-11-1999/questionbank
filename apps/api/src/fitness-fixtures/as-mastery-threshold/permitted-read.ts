/**
 * Permitted: a threshold read from the rule set in hand, which is what every production use is. No literal on the line, so the rule says nothing.
 * Never imported by production code.
 */
export function enough(thresholds: { promotion: { minResponses: number } }, responses: number): boolean {
  const minResponses = thresholds.promotion.minResponses;
  return responses >= minResponses;
}
