import { buildFormPackage, buildPracticePackage, type JsonValue } from '../../domain/form-package.js';
import { slotsOf } from '../../domain/form.js';
import type { AttemptRepository, FormRepository } from '../../domain/repository-ports.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, authorize, fromAssessment, type ApplicationError } from '../authorization.js';
import type { GetFormPackage, GetPackageSigningKey, GetPracticePackage } from '../commands/form-commands.js';
import type { Handler } from '../handler-registry.js';
import { GET_FORM_PACKAGE_POLICY, GET_PACKAGE_SIGNING_KEY_POLICY, GET_PRACTICE_PACKAGE_POLICY } from '../policies.js';
import type { ApplicationContext, Clock, FormContentReader, PackageSigner } from '../ports.js';
import { ownAttempt } from './attempt-handlers.js';

export interface PackageDependencies {
  readonly forms: Pick<FormRepository, 'findById'>;
  readonly content: FormContentReader;
  readonly clock: Clock;
  /** Absent when the deployment configured no signing key; the package is then not served at all. */
  readonly signer: PackageSigner | undefined;
}

export interface PracticePackageDependencies extends Pick<PackageDependencies, 'content' | 'signer'> {
  readonly attempts: Pick<AttemptRepository, 'findById'>;
}

export interface BuiltPackage {
  readonly formId: string;
  readonly bytes: Uint8Array;
  readonly slotIds: readonly string[];
  readonly digest: string;
  readonly signature: string;
  readonly keyId: string;
}

const SIGNING_UNAVAILABLE = () =>
  applicationError('Unavailable', 'PACKAGE_SIGNING_UNAVAILABLE', 'form packages are not served: no signing key is configured');

/**
 * Builds the package for an active form. The form is read through its
 * repository and **the content is read by the version ids the form pins**, each
 * once: an item version and a stimulus version two slots share are fetched once
 * and appear once. The caller's own context is passed to content, so what the
 * caller may read there is what content's own policy says.
 */
export class GetFormPackageHandler implements Handler<GetFormPackage, BuiltPackage> {
  readonly name = 'GetFormPackage';
  readonly policy = GET_FORM_PACKAGE_POLICY;

  constructor(private readonly deps: PackageDependencies) {}

  async handle(query: GetFormPackage, context: ApplicationContext): Promise<Result<BuiltPackage, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    // Before any work, and never an unsigned package: a device told to trust bytes nothing vouches for is worse than one told to wait.
    const signer = this.deps.signer;
    if (signer === undefined) return err(SIGNING_UNAVAILABLE());

    const found = await this.deps.forms.findById(query.formId);
    if (!found.ok) return err(fromAssessment(found.error));
    const form = found.value;

    // The state says an operator opened it; the clock says the window is the truth. Both, as creating an attempt does (D36).
    const now = this.deps.clock.now().toISOString();
    if (form.state === 'active' && form.scheduleWindow !== null && (now < form.scheduleWindow.opensAt || now >= form.scheduleWindow.closesAt)) {
      return err(applicationError('PreconditionFailed', 'FORM_WINDOW_NOT_OPEN', 'the form\'s window is not open at this moment', 'scheduleWindow'));
    }

    const slots = slotsOf(form);
    const items = new Map<string, JsonValue>();
    for (const slot of slots) {
      if (items.has(slot.itemVersionId)) continue;
      const view = await this.deps.content.itemVersion(slot.itemVersionId, context);
      if (!view.ok) return err(view.error);
      items.set(slot.itemVersionId, view.value);
    }
    const stimuli = new Map<string, JsonValue>();
    for (const slot of slots) {
      if (slot.stimulusVersionId === null || stimuli.has(slot.stimulusVersionId)) continue;
      const view = await this.deps.content.stimulusVersion(slot.stimulusVersionId, context);
      if (!view.ok) return err(view.error);
      stimuli.set(slot.stimulusVersionId, view.value);
    }

    const built = buildFormPackage(form, { items, stimuli });
    if (!built.ok) return err(fromAssessment(built.error));
    return ok(Object.freeze({ formId: built.value.formId, bytes: built.value.bytes, slotIds: built.value.slotIds, ...signer.sign(built.value.bytes) }));
  }
}

export interface BuiltPracticePackage {
  readonly attemptId: string;
  readonly bytes: Uint8Array;
  readonly slotIds: readonly string[];
  readonly digest: string;
  readonly signature: string;
  readonly keyId: string;
}

/**
 * The package of a practice run (M8-23, closes D87; ADR-0061, DEC-M8-13 in docs/IMPLEMENTATION-DECISIONS.md): the questions of one learner's run, signed with the key a form's package is signed with, never unsigned.
 *
 * **It is private.** A form's package is byte-identical for everyone entitled to the form; this one is made from the slots of one attempt, so the caller must own the attempt, and
 * anyone else's — or one that does not exist — is the same NotFound, with no bytes (`ownAttempt`). What changed about the ETag's reasoning: the digest is still the identity of these bytes,
 * but the bytes are the attempt's and not a form's, so equal digests mean the same run in the same state and not the same form.
 *
 * **A grown run is a changed package.** `GrowPracticeAttempt` appends slots, so the next package has more of them and a different digest. A device that holds the old digest and asks again
 * is given the new bytes (the route revalidates every time, `private, no-cache`); the device learns a run has grown from the attempt's slot count, which it reads beside.
 *
 * **Serving it is not a delivery.** The exposure ledger counts a practice item when its slot is appended (the database refuses a practice slot without its ledger row, M7-30); reading the
 * package writes nothing, so asking twice, or from a second device, counts nothing twice.
 */
export class GetPracticePackageHandler implements Handler<GetPracticePackage, BuiltPracticePackage> {
  readonly name = 'GetPracticePackage';
  readonly policy = GET_PRACTICE_PACKAGE_POLICY;

  constructor(private readonly deps: PracticePackageDependencies) {}

  async handle(query: GetPracticePackage, context: ApplicationContext): Promise<Result<BuiltPracticePackage, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const signer = this.deps.signer;
    if (signer === undefined) return err(SIGNING_UNAVAILABLE());

    const owned = await ownAttempt(this.deps, query.attemptId, context);
    if (!owned.ok) return owned;
    const attempt = owned.value;
    if (attempt.mode !== 'practice') return err(applicationError('PreconditionFailed', 'ATTEMPT_NOT_PRACTICE', 'this attempt is not a practice run; a paper is fetched by its form', 'mode'));

    const items = new Map<string, JsonValue>();
    for (const slot of attempt.slots) {
      if (items.has(slot.itemVersionId)) continue;
      const view = await this.deps.content.itemVersion(slot.itemVersionId, context);
      if (!view.ok) return err(view.error);
      items.set(slot.itemVersionId, view.value);
    }
    const stimuli = new Map<string, JsonValue>();
    for (const slot of attempt.slots) {
      if (slot.stimulusVersionId === null || stimuli.has(slot.stimulusVersionId)) continue;
      const view = await this.deps.content.stimulusVersion(slot.stimulusVersionId, context);
      if (!view.ok) return err(view.error);
      stimuli.set(slot.stimulusVersionId, view.value);
    }
    const built = buildPracticePackage(attempt, { items, stimuli });
    if (!built.ok) return err(fromAssessment(built.error));
    return ok(Object.freeze({ attemptId: built.value.attemptId, bytes: built.value.bytes, slotIds: built.value.slotIds, ...signer.sign(built.value.bytes) }));
  }
}

export interface SigningKeyView {
  readonly algorithm: 'Ed25519';
  readonly keyId: string;
  readonly publicKey: string;
}

export class GetPackageSigningKeyHandler implements Handler<GetPackageSigningKey, SigningKeyView> {
  readonly name = 'GetPackageSigningKey';
  readonly policy = GET_PACKAGE_SIGNING_KEY_POLICY;

  constructor(private readonly deps: Pick<PackageDependencies, 'signer'>) {}

  async handle(_query: GetPackageSigningKey, context: ApplicationContext): Promise<Result<SigningKeyView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const signer = this.deps.signer;
    if (signer === undefined) return err(SIGNING_UNAVAILABLE());
    return ok(Object.freeze({ algorithm: 'Ed25519' as const, keyId: signer.keyId, publicKey: signer.publicKey }));
  }
}
