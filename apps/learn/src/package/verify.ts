/**
 * Verifies a form package's signature (M6-48): the client's half of Track D's signing.
 *
 * The server signs the **exact bytes** it sends (Ed25519), so this checks the bytes as received and parses nothing until they pass.
 * The check never throws: a key that is not a key, a signature that is not base64, a runtime that cannot do Ed25519 — each is a
 * package that is not vouched for, and the answer is `false`. A caller that gets `false` renders nothing from the package.
 */
export interface PackageEvidence {
  readonly bytes: Uint8Array;
  /** Base64, from `X-Package-Signature`. */
  readonly signature: string;
  /** SPKI DER, base64, from the signing-key route. */
  readonly publicKey: string;
  /** `sha256=<hex>`, from `X-Package-Digest`; checked as well as the signature, so a mismatched header is a refusal too. */
  readonly digest: string;
}

const base64ToBytes = (text: string): Uint8Array => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

const hex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export async function verifyPackage(evidence: PackageEvidence): Promise<boolean> {
  try {
    const digest = hex(await crypto.subtle.digest('SHA-256', evidence.bytes as BufferSource));
    if (evidence.digest !== `sha256=${digest}`) return false;
    const key = await crypto.subtle.importKey('spki', base64ToBytes(evidence.publicKey) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, base64ToBytes(evidence.signature) as BufferSource, evidence.bytes as BufferSource);
  } catch {
    return false;
  }
}
