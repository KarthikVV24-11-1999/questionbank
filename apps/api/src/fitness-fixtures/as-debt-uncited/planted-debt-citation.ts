// Planted violation for debt-rules.spec.ts — a citation of an identifier
// that docs/DEBT.md does not carry, proving the check can fail. D99 is
// deliberately far outside the register's range so it can never collide
// with a real entry. Never imported by production code.
export const PLANTED_NOTE = 'this behaviour is a known gap, recorded as debt D99';
