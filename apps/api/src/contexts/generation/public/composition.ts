import type { Pool } from 'pg';
import type { DynamicModule } from '@nestjs/common';
import type {
  AuthoredItemContent,
  CreateItemDraft,
  DuplicateCandidatesResult,
  GetDuplicateCandidatesForProposal,
  ProposalFacts,
  SubmitItemForReview,
  ValidationReport,
} from '../../content/public/index.js';
import type { GetTaxonomyVersion, TaxonomyVersionDetailView } from '../../curriculum/public/index.js';
import type { PrincipalResolver } from '../api/generation.controller.js';
import { GenerationModule } from '../api/generation.module.js';
import { composeGenerationHandlers } from '../application/compose-handlers.js';
import type { AuditRecorder, Clock, IdentifierFactory, JudgementProvider, ProposalProvider } from '../application/ports.js';
import { buildPrechecks, unconfiguredPrechecks } from '../application/prechecks/index.js';
import type { PrecheckConfig } from '../application/prechecks/judge.js';
import { ContentCommandAuthoring, type CommandHandler } from '../infrastructure/content-command-authoring.js';
import { ContentProposalChecker } from '../infrastructure/content-proposal-checks.js';
import { CurriculumSyllabusReader } from '../infrastructure/curriculum-syllabus-reader.js';
import { PostgresGenerationCandidateRepository } from '../infrastructure/generation-candidate.repository.js';
import { PostgresGenerationRunRepository } from '../infrastructure/generation-run.repository.js';
import { UnconfiguredProvider } from '../infrastructure/provider/unconfigured-provider.js';
import { PostgresVersionRegistry } from '../infrastructure/version-registry.repository.js';

/**
 * The composition seam (DEC-M0-5, ADR-0015), following `contexts/content/public/composition.ts`.
 * `register` builds generation's repositories, its adapters over content and
 * curriculum, and its handlers, and returns the module that carries them.
 *
 * **Generation holds no content or curriculum code.** What it calls in those
 * contexts arrives in `deps` as handlers they chose to hand over
 * (`contentForGeneration`, `curriculumForGeneration` in their own seams), declared
 * here by the shape generation needs of them and nothing else (ADR-0025). The root
 * passes one context's output to the other's input and decides nothing.
 *
 * **The provider is optional, and absent means unconfigured.** No live adapter
 * exists; a deployment without one is composed with `UnconfiguredProvider`, which
 * answers every call as unavailable. The recorded adapter is a test fixture and the
 * root never chooses it — a test passes it in.
 *
 * **The pre-check configuration is optional, and absent means nothing can be
 * accepted.** Present, it is validated here when the battery is built, and one that
 * cannot be right refuses boot (`InvalidPrecheckConfigurationError`) rather than
 * producing a battery that fails at its first check.
 */
export interface GenerationCompositionDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
  readonly principals: PrincipalResolver;
  /** Content's handlers generation may call — content's `contentForGeneration`, passed through. */
  readonly content: {
    readonly createDraft: CommandHandler<CreateItemDraft, { readonly itemId: string }>;
    readonly submitForReview: CommandHandler<SubmitItemForReview, unknown>;
    readonly duplicatesForProposal: CommandHandler<GetDuplicateCandidatesForProposal, DuplicateCandidatesResult>;
    readonly validateProposal: (content: AuthoredItemContent, facts: ProposalFacts) => ValidationReport;
  };
  /** Curriculum's read generation may call — curriculum's `curriculumForGeneration`, passed through. */
  readonly curriculum: {
    readonly taxonomyVersion: CommandHandler<GetTaxonomyVersion, TaxonomyVersionDetailView>;
  };
  readonly provider?: ProposalProvider & JudgementProvider;
  readonly precheckConfig?: Readonly<Record<string, { readonly modelVersionId: string; readonly promptVersionId: string }>>;
}

const REQUIRED_DEPS_KEYS = [
  'pool',
  'clock',
  'identifiers',
  'audit',
  'principals',
  'content',
  'curriculum',
] as const satisfies readonly (keyof GenerationCompositionDeps)[];

export function register(deps: GenerationCompositionDeps): DynamicModule {
  for (const key of REQUIRED_DEPS_KEYS) {
    if (deps[key] === undefined) {
      throw new Error(`generation composition is missing required dependency: ${key}`);
    }
  }

  const provider = deps.provider ?? new UnconfiguredProvider();
  const prechecks =
    deps.precheckConfig === undefined
      ? unconfiguredPrechecks()
      : buildPrechecks({
          registry: new PostgresVersionRegistry(deps.pool),
          judge: provider,
          syllabus: new CurriculumSyllabusReader(deps.curriculum.taxonomyVersion),
          content: new ContentProposalChecker({ validate: deps.content.validateProposal, duplicates: deps.content.duplicatesForProposal }),
          clock: deps.clock,
          // Shape was checked by config; the registry ids and distinct prompts are checked by buildPrechecks, which refuses boot on a failure.
          config: deps.precheckConfig as PrecheckConfig,
        });

  const registry = composeGenerationHandlers({
    runs: new PostgresGenerationRunRepository(deps.pool),
    candidates: new PostgresGenerationCandidateRepository(deps.pool),
    clock: deps.clock,
    identifiers: deps.identifiers,
    audit: deps.audit,
    provider,
    content: new ContentCommandAuthoring({ createDraft: deps.content.createDraft, submitForReview: deps.content.submitForReview }),
    ...prechecks,
  });

  return GenerationModule.register({ registry, principals: deps.principals });
}
