import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';

/**
 * A package signed the way the server signs one (Ed25519 over the exact bytes), for specs: nothing here is the server's code, so a
 * client that verifies these bytes verifies what a server would send, not what a shared helper agrees with itself about.
 */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function aSigner(seedByte = 7) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.alloc(32, seedByte)]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return {
    publicKey: spki.toString('base64'),
    keyId: createHash('sha256').update(spki).digest('hex').slice(0, 16),
    sign: (bytes: Uint8Array) => ({
      signature: sign(null, bytes, privateKey).toString('base64'),
      digest: `sha256=${createHash('sha256').update(bytes).digest('hex')}`,
    }),
  };
}

export const slotIds = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a3'] as const;

const text = (value: string) => ({ schemaVersion: 1, blocks: [{ kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value, marks: [] }] }] });

/** A package document in the server's shape: three single-answer questions, one with a stimulus. */
export function aPackageDocument(extra: Record<string, unknown> = {}) {
  return {
    format: 'questionbank.form-package',
    formatVersion: 1,
    form: {
      formId: '00000000-0000-4000-8000-0000000000f1',
      examProfileVersionId: '00000000-0000-4000-8000-0000000000e1',
      formType: 'mock',
      sessionRefs: ['2026-01-27/shift-1'],
      publishedAt: '2026-10-21T07:00:00.000Z',
      window: { opensAt: '2026-10-21T08:00:00.000Z', closesAt: '2026-10-21T12:00:00.000Z' },
    },
    sections: [
      {
        ordinal: 1,
        sectionSpecRef: 'physics',
        slots: slotIds.map((slotId, index) => ({
          slotId,
          ordinal: index + 1,
          marksAvailable: 4,
          itemVersionId: `00000000-0000-4000-8000-0000000000b${index + 1}`,
          ...(index === 0 ? { stimulusVersionId: '00000000-0000-4000-8000-0000000000c1' } : {}),
          item: {
            itemVersionId: `00000000-0000-4000-8000-0000000000b${index + 1}`,
            itemId: `00000000-0000-4000-8000-0000000000d${index + 1}`,
            versionNo: 1,
            itemType: 'SINGLE_CORRECT_MCQ',
            stem: text(`Question ${index + 1}: which is right?`),
            options: ['a', 'b', 'c', 'd'].map((optionId, i) => ({ optionId, ordinal: i + 1, body: text(`Option ${optionId.toUpperCase()}`) })),
            ...(index === 0 ? { stimulusVersionId: '00000000-0000-4000-8000-0000000000c1' } : {}),
            ...extra,
          },
        })),
      },
    ],
    stimuli: [{ stimulusVersionId: '00000000-0000-4000-8000-0000000000c1', view: { body: text('A passage that question one refers to.') } }],
  };
}

export const encode = (document: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(document));
