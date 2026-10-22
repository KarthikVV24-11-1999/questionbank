import { readFileSync } from 'node:fs';
export const read = (path: string): string => readFileSync(path, 'utf8');
