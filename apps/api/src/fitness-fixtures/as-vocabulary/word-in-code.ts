/** Our words in strings that code builds for a learner: a message, a label made out of an identifier, a word reached through a template. */
export const WHY = 'This concept keeps slipping.';
export const label = (id: string): string => `Concept ${id.slice(0, 8)}`;
export const nested = (ok: boolean): string => `${ok ? 'Your taxonomy' : 'none'}`;
export const labels = ["Item versions"];
