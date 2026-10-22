import type { Pool } from 'pg';
import type { DynamicModule } from '@nestjs/common';
import type { PrincipalResolver } from '../api/assessment.controller.js';
import { AssessmentModule } from '../api/assessment.module.js';
import { composeAssessmentHandlers } from '../application/compose-handlers.js';
import type { AuditRecorder, Clock, IdentifierFactory } from '../application/ports.js';
import { PostgresAnchorPoolRepository } from '../infrastructure/anchor-pool.repository.js';
import { PostgresAttemptRepository } from '../infrastructure/attempt.repository.js';
import { ContentCorpus, type CatalogueHandler, type DuplicatesHandler } from '../infrastructure/content-corpus.js';
import { CurriculumPinSource, type ProfilePinsHandler } from '../infrastructure/curriculum-pin-source.js';
import { ContentFormReader } from '../infrastructure/content-form-reader.js';
import { PostgresExposureLedger } from '../infrastructure/exposure-ledger.repository.js';
import { PostgresFormRepository } from '../infrastructure/form.repository.js';
import { Ed25519PackageSigner } from '../infrastructure/package-signer.js';
import { PostgresResponseLog } from '../infrastructure/response-log.repository.js';

/**
 * The composition seam (DEC-M0-5, ADR-0015). `register` builds assessment's
 * repositories, its adapter over content, and its handlers, and returns the module
 * that carries them.
 *
 * **Assessment holds no content code.** What it calls in content arrives in `deps`
 * as the two handlers content chose to hand over (`contentForAssessment`, in
 * content's own seam), declared here by the shape assessment needs of them and
 * nothing else. The root passes one context's output to the other's input and
 * decides nothing — which is why no assessment file imports anything from content.
 */
export interface AssessmentCompositionDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
  readonly principals: PrincipalResolver;
  /**
   * The Ed25519 seed packages are signed with (M6-26), base64. Absent, and the
   * package routes answer as unavailable rather than serving bytes nothing vouches for.
   */
  readonly packageSigningKey?: string;
  /** Curriculum's one read assessment makes — `curriculumForAssessment`, passed through. */
  readonly curriculum: { readonly examProfilePins: ProfilePinsHandler };
  /** Content's handlers assessment may call — content's `contentForAssessment`, passed through. */
  readonly content: {
    readonly listCatalogue: CatalogueHandler;
    readonly duplicates: DuplicatesHandler;
    readonly itemVersion: ConstructorParameters<typeof ContentFormReader>[0]['itemVersion'];
    readonly stimulusVersion: ConstructorParameters<typeof ContentFormReader>[0]['stimulusVersion'];
  };
}

const REQUIRED_DEPS_KEYS = ['pool', 'clock', 'identifiers', 'audit', 'principals', 'content', 'curriculum'] as const satisfies readonly (keyof AssessmentCompositionDeps)[];

export function register(deps: AssessmentCompositionDeps): DynamicModule {
  for (const key of REQUIRED_DEPS_KEYS) {
    if (deps[key] === undefined) {
      throw new Error(`assessment composition is missing required dependency: ${key}`);
    }
  }

  const registry = composeAssessmentHandlers({
    forms: new PostgresFormRepository(deps.pool),
    attempts: new PostgresAttemptRepository(deps.pool),
    responses: new PostgresResponseLog(deps.pool),
    corpus: new ContentCorpus({
      catalogue: deps.content.listCatalogue,
      duplicates: deps.content.duplicates,
      anchors: new PostgresAnchorPoolRepository(deps.pool),
      exposure: new PostgresExposureLedger(deps.pool),
    }),
    content: new ContentFormReader({ itemVersion: deps.content.itemVersion, stimulusVersion: deps.content.stimulusVersion }),
    pins: new CurriculumPinSource(deps.curriculum.examProfilePins),
    clock: deps.clock,
    identifiers: deps.identifiers,
    audit: deps.audit,
    signer: deps.packageSigningKey === undefined ? undefined : new Ed25519PackageSigner(deps.packageSigningKey),
  });

  return AssessmentModule.register({ registry, principals: deps.principals });
}
