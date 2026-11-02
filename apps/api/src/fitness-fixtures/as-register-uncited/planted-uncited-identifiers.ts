// Planted violation for register-rules.spec.ts — citations of identifiers
// neither register carries, proving both checks can fail. D999 and DEC-M9-99
// are deliberately far outside either register's range so they can never
// collide with a real entry. Never imported by production code.
export const PLANTED_DEBT_NOTE = 'this behaviour is a known gap, recorded as debt D999';
export const PLANTED_DECISION_NOTE = 'the shape this takes was settled at DEC-M9-99';
