import type { PrincipalRef } from '@questionbank/domain-types';
import type { AssemblyCandidate } from '../domain/assembly.js';
import type { JsonValue } from '../domain/form-package.js';
import type { BlueprintItemType } from '../domain/blueprint.js';
import type { Attempt } from '../domain/attempt.js';
import type { PracticePolicy } from '../domain/delivery-policy.js';
import type { ReleasedSlot } from '../domain/solution-release.js';
import type { Result } from '../domain/result.js';
import type { ApplicationError, AuthorizationContext } from './authorization.js';

export interface ApplicationContext extends AuthorizationContext {
  readonly correlationId: string;
}

/**
 * One row per consequential command (DATA-ARCHITECTURE P3). It names the
 * principal, the action and the target, and never the form's content (§7).
 */
export interface AuditRecord {
  readonly principal: PrincipalRef;
  readonly action: string;
  readonly targetContext: 'assessment';
  readonly targetType: string;
  readonly targetId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

export interface AuditRecorder {
  record(entry: AuditRecord): Promise<void>;
}

/** The clock lives here, not in the domain: every instant the domain reasons about is supplied. */
export interface Clock {
  now(): Date;
}

export interface IdentifierFactory {
  next(): string;
}

/** What form assembly selects from, gathered by an adapter over content and the pool and the ledger. */
export interface LoadedCorpus {
  readonly candidates: readonly AssemblyCandidate[];
  readonly exposure: ReadonlyMap<string, number>;
  readonly nearDuplicates: ReadonlyMap<string, ReadonlySet<string>>;
  /** Published versions content has no fingerprint for, left out (D55). */
  readonly unevaluated: readonly string[];
}

/**
 * The corpus, as the application asks for it. The adapter behind it
 * (`ContentCorpus`) calls content through the seam the composition root
 * passes; the application layer names no content handler.
 */
export interface FormCorpus {
  load(
    request: { readonly subject?: string; readonly itemTypes?: readonly BlueprintItemType[] },
    context: ApplicationContext,
  ): Promise<Result<LoadedCorpus, ApplicationError>>;
}

/**
 * The delivery views of the versions a form pinned, by version id. The adapter
 * behind it calls content's two reads-by-version through the seam; the
 * application layer names no content handler, and receives opaque JSON it does
 * not interpret.
 */
export interface FormContentReader {
  itemVersion(itemVersionId: string, context: ApplicationContext): Promise<Result<JsonValue, ApplicationError>>;
  stimulusVersion(stimulusVersionId: string, context: ApplicationContext): Promise<Result<JsonValue, ApplicationError>>;
}

/** The digest and signature of a package's exact bytes, and which key made the signature. */
export interface SignedPackage {
  readonly digest: string;
  readonly signature: string;
  readonly keyId: string;
}

/**
 * Signs a package (M6-26). An outbound port: the algorithm and the key are
 * infrastructure's, and the application only asks for the bytes it built to be
 * signed.
 */
export interface PackageSigner {
  readonly keyId: string;
  /** The public key, SPKI DER, base64 — what a device verifies against. */
  readonly publicKey: string;
  sign(bytes: Uint8Array): SignedPackage;
}

/** What an attempt copies from the exam profile version its form was built for (INV-04), and the length of the sitting. */
export interface AttemptPins {
  readonly taxonomyVersionId: string;
  readonly markingRuleSetHash: string;
  readonly durationMs: number;
  readonly deliveryPolicy: Readonly<Record<string, unknown>>;
}

/**
 * Where the pins come from. An outbound port: the adapter behind it calls curriculum through the
 * seam the composition root passes, and the application layer names no curriculum handler.
 */
export interface AttemptPinSource {
  pinsFor(examProfileVersionId: string, context: ApplicationContext): Promise<Result<AttemptPins, ApplicationError>>;
}

/** What a practice attempt pins from the exam profile version it is sat against, and the delivery document derived for it (M7-26). */
export interface PracticePins {
  readonly taxonomyVersionId: string;
  readonly markingRuleSetHash: string;
  readonly isTimed: boolean;
  readonly durationMs: number | null;
  readonly deliveryPolicy: Readonly<Record<string, unknown>>;
}

export interface PracticePinSource {
  practicePinsFor(examProfileVersionId: string, policy: PracticePolicy, context: ApplicationContext): Promise<Result<PracticePins, ApplicationError>>;
}

/**
 * Where the targeted strategy's concepts come from (M7-28): a port whose adapter calls Learning through the seam the composition root passes. The
 * answer is concept identities and nothing else; assessment turns them into slots against the published catalogue.
 */
export interface RemediationSource {
  conceptsFor(taxonomyVersionId: string, limit: number, context: ApplicationContext): Promise<Result<readonly string[], ApplicationError>>;
}

/**
 * What marking says of one recorded answer (M7-29): the correctness the pinned rules attribute to it, as a word, and nothing else. The adapter behind it
 * asks content for the key and scoring for the rule, both under the system's identity; the application layer holds neither and names neither.
 */
export interface ResponseJudge {
  judge(attempt: Attempt, slotId: string, answer: unknown, context: ApplicationContext): Promise<Result<string, ApplicationError>>;
}

/** A piece of authored content (stem-free): the body of a step or an explanation, opaque to this context and handed on as it came. */
export type SolutionBody = unknown;

export interface SolutionStepContent {
  readonly ordinal: number;
  readonly body: SolutionBody;
  readonly conceptRefs: readonly string[];
}

/**
 * A published solution as content delivers it, in the shape assessment needs of it (M7-37). The structured final-answer assertion is not here and is not
 * delivered by content either: the steps state the answer in prose, which is what a learner reads. `distractorAnalyses` and `alternateApproaches` are present
 * only at the full depth.
 */
export interface SolutionContent {
  readonly solutionVersionId: string;
  readonly targetItemVersionId: string;
  readonly steps: readonly SolutionStepContent[];
  readonly distractorAnalyses?: readonly { readonly optionId: string; readonly misconception: SolutionBody }[];
  readonly alternateApproaches?: readonly { readonly label: string; readonly steps: readonly SolutionStepContent[]; readonly applicabilityNote?: string }[];
}

/**
 * Where a solution comes from — an outbound port whose adapter calls content through the seam the composition root passes. **It takes a `ReleasedSlot`**, a type
 * only the effort gate's repository can make, and not an item version id: there is no way to ask for a solution here that has not been through the gate.
 */
export interface SolutionSource {
  solutionFor(slot: ReleasedSlot, depth: 'basic' | 'full', context: ApplicationContext): Promise<Result<SolutionContent, ApplicationError>>;
}
