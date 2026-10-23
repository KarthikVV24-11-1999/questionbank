import { formPackageSchema, type FormPackage } from './types.js';
import { verifyPackage } from './verify.js';

/**
 * Brings a package to the screen only if it is vouched for (M6-48).
 *
 * **An unverifiable package never renders an item.** The order is fixed and the result is a closed set: the bytes are verified
 * first, against a key fetched on its own and a signature carried beside them; only then are they decoded and parsed. A package
 * that fails is *refused* — a value the caller cannot mistake for a package — not reported alongside one, so there is no code path
 * on which an item from a failed package is available to render.
 */
export type PackageRefusal =
  | 'SIGNATURE_MISSING'
  | 'KEY_MISSING'
  | 'SIGNATURE_DOES_NOT_VERIFY'
  | 'KEY_ID_DOES_NOT_MATCH'
  | 'NOT_A_PACKAGE_THIS_BUILD_UNDERSTANDS';

export type LoadedPackage =
  | { readonly ok: true; readonly form: FormPackage; readonly digest: string }
  | { readonly ok: false; readonly refusal: PackageRefusal };

export interface PackageResponse {
  readonly bytes: Uint8Array;
  readonly signature: string | null;
  readonly digest: string | null;
  readonly keyId: string | null;
}

export interface SigningKey {
  readonly keyId: string;
  readonly publicKey: string;
}

export async function loadPackage(response: PackageResponse, key: SigningKey | null): Promise<LoadedPackage> {
  if (response.signature === null || response.digest === null) return { ok: false, refusal: 'SIGNATURE_MISSING' };
  if (key === null) return { ok: false, refusal: 'KEY_MISSING' };
  if (response.keyId !== key.keyId) return { ok: false, refusal: 'KEY_ID_DOES_NOT_MATCH' };

  const verified = await verifyPackage({ bytes: response.bytes, signature: response.signature, publicKey: key.publicKey, digest: response.digest });
  if (!verified) return { ok: false, refusal: 'SIGNATURE_DOES_NOT_VERIFY' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(response.bytes));
  } catch {
    return { ok: false, refusal: 'NOT_A_PACKAGE_THIS_BUILD_UNDERSTANDS' };
  }
  const form = formPackageSchema.safeParse(parsed);
  return form.success ? { ok: true, form: form.data, digest: response.digest } : { ok: false, refusal: 'NOT_A_PACKAGE_THIS_BUILD_UNDERSTANDS' };
}
