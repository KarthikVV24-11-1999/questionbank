import { buildFormPackage, type JsonValue } from '../../domain/form-package.js';
import { slotsOf } from '../../domain/form.js';
import type { FormRepository } from '../../domain/repository-ports.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, authorize, fromAssessment, type ApplicationError } from '../authorization.js';
import type { GetFormPackage, GetPackageSigningKey } from '../commands/form-commands.js';
import type { Handler } from '../handler-registry.js';
import { GET_FORM_PACKAGE_POLICY, GET_PACKAGE_SIGNING_KEY_POLICY } from '../policies.js';
import type { ApplicationContext, Clock, FormContentReader, PackageSigner } from '../ports.js';

export interface PackageDependencies {
  readonly forms: Pick<FormRepository, 'findById'>;
  readonly content: FormContentReader;
  readonly clock: Clock;
  /** Absent when the deployment configured no signing key; the package is then not served at all. */
  readonly signer: PackageSigner | undefined;
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
