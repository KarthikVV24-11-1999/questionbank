/**
 * The PII gate of the analytics edge (EVENT-TAXONOMY §1 rule 1, PRI-08, F10): **no name, email or phone number in any field of any event, ever.**
 *
 * An event is scanned whole — envelope and payload, every key and every string value, at any depth — so a field nobody listed is still looked at. Three checks,
 * each catching what the others miss:
 *
 *   - **by key** — a field named for a person's details (`name`, `email`, `phone`, `address`, …), exactly, whatever the case or separators.
 *   - **by value** — an email address, or a run of digits that is a phone number, wherever it sits.
 *   - **by shape** — a string with whitespace or longer than an identifier could be. Every legitimate value in the catalog is a number, a flag, an enumerated word or an
 *     identifier, so free text is where a person's name would have to be to get through under a harmless key.
 *
 * What it does not claim: a single-word name under a harmless key (`"label": "Asha"`) is neither a key, an address, a number nor free text, and passes.
 * The static side of the gate is that nothing builds an event from a person's record in the first place.
 */
export type PiiKind = 'key' | 'email' | 'phone' | 'free-text';

export interface PiiFinding {
  readonly path: string;
  readonly kind: PiiKind;
}

// Exact names, compared without case or separators: `event_name` is the catalog's own field and is not a person's name, so a pattern on "name" would refuse every event.
const PERSONAL_KEYS = new Set([
  'name', 'firstname', 'lastname', 'fullname', 'displayname', 'username', 'surname', 'givenname', 'familyname',
  'email', 'emailaddress', 'phone', 'phonenumber', 'mobile', 'mobilenumber', 'msisdn',
  'address', 'streetaddress', 'dob', 'dateofbirth', 'birthdate', 'aadhaar', 'pan',
]);
export const isPersonalKey = (key: string): boolean => PERSONAL_KEYS.has(key.toLowerCase().replace(/[_.\s-]/gu, ''));
const EMAIL = /[^\s@"']+@[^\s@"']+\.[A-Za-z]{2,}/u;
// seven or more digits, with the separators people put between them, not inside a longer identifier (a UUID, a timestamp)
const PHONE = /(?<![\w-])\+?\d(?:[\s().-]?\d){6,14}(?![\w-])/u;
const MAX_VALUE_LENGTH = 200;

export function findPii(value: unknown, path = '$'): PiiFinding[] {
  if (typeof value === 'string') {
    if (EMAIL.test(value)) return [{ path, kind: 'email' }];
    if (PHONE.test(value)) return [{ path, kind: 'phone' }];
    if (/\s/u.test(value) || value.length > MAX_VALUE_LENGTH) return [{ path, kind: 'free-text' }];
    return [];
  }
  // a ten-digit mobile number written as a number; the catalog's counts and durations do not reach it
  if (typeof value === 'number' && Number.isInteger(value) && value >= 6_000_000_000 && value <= 9_999_999_999) return [{ path, kind: 'phone' }];
  if (Array.isArray(value)) return value.flatMap((item, index) => findPii(item, `${path}[${index}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, inner]) => [...(isPersonalKey(key) ? [{ path: `${path}.${key}`, kind: 'key' as const }] : []), ...findPii(inner, `${path}.${key}`)]);
  }
  return [];
}
