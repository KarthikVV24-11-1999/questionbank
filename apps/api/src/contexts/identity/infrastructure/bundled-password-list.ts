import type { BreachedPasswords, BreachVerdict } from '../application/ports.js';
import { COMMON_PASSWORDS } from './common-passwords.js';

/**
 * The password source for now (M8-11): a list that ships with the code, and two shapes no list needs to hold.
 *
 * **Why bundled, and not the Pwned Passwords range service.** A set lookup costs nothing at request time, needs no network on the registration and reset paths, and has no outage to
 * choose a behaviour for. The range service is current and enormous, and its k-anonymity (only the first five hex digits of a SHA-1 leave the process) means the password is not
 * disclosed; what it adds is a third party's latency and availability on paths that must not block. A short list now and the port shaped for the service later is the cheaper way to be
 * wrong. What it gives up is coverage, which D100 in docs/DEBT.md carries, and freshness, which a list in the repository never has.
 *
 * **Matching.** The password arrives in the hasher's form (`normalisePassword`) and is lower-cased, so `Password1234` and `PASSWORD1234` are the same guess as `password1234`: a
 * stuffing run mangles case before it does anything else. A match is of the whole password. The two shapes: one short unit repeated, ending mid-unit or not (`abababababab`, `abababababa`), and a run
 * that steps one character up or down the whole way (`abcdefghijkl`); neither could be listed, since there are too many, and both are among a guesser's first.
 */
const REPEAT_UNIT_MAX = 4;

const LISTED: ReadonlySet<string> = new Set(COMMON_PASSWORDS);

function repeatsAUnit(text: string): boolean {
  const points = [...text];
  for (let size = 1; size <= REPEAT_UNIT_MAX; size += 1) {
    if (points.every((point, index) => point === points[index % size])) return true;
  }
  return false;
}

function stepsByOne(text: string): boolean {
  const codes = [...text].map((point) => point.codePointAt(0) as number);
  const step = (codes[1] as number) - (codes[0] as number);
  return Math.abs(step) === 1 && codes.every((code, index) => index === 0 || code - (codes[index - 1] as number) === step);
}

export class BundledPasswordList implements BreachedPasswords {
  lookup(normalised: string): Promise<BreachVerdict> {
    const folded = normalised.toLowerCase();
    const known = LISTED.has(folded) || repeatsAUnit(folded) || stepsByOne(folded);
    return Promise.resolve(known ? 'breached' : 'not_found');
  }
}
