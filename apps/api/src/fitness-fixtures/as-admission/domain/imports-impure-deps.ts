// @ts-expect-error — a planted workspace member, resolvable only by the rule under test
import { x } from '@questionbank/impure-deps';
export const used = x;
