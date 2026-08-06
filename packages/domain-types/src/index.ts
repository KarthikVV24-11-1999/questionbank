/**
 * The shared kernel — exactly three types (ENGINEERING-HANDBOOK §9 rule 5).
 * Nothing else may be added here without an ADR.
 */

export type UserId = string;

export type RoleSet = readonly string[];

export type PrincipalKind = 'human' | 'ai_agent' | 'system';

/** Every mutation carries one, human or machine (DOMAIN-MODEL §2 D10). */
export interface PrincipalRef {
  readonly kind: PrincipalKind;
  readonly id: UserId;
  readonly roleContext: RoleSet;
}
