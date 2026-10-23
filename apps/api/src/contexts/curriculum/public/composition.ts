import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { DynamicModule } from '@nestjs/common';
import type { Handler } from '../application/handler-registry.js';
import type { AuditRecorder, Clock, IdentifierFactory } from '../application/ports.js';
import type { PrincipalResolver } from '../api/curriculum.controller.js';
import { CurriculumModule } from '../api/curriculum.module.js';
import { DrizzleExamRepository } from '../infrastructure/exam.repository.js';
import { DrizzleExamProfileVersionRepository } from '../infrastructure/exam-profile-version.repository.js';
import { DrizzleTaxonomyVersionRepository } from '../infrastructure/taxonomy-version.repository.js';
import { DrizzleConceptIdentityRepository } from '../infrastructure/concept-identity.repository.js';
import { DrizzleTaxonomyMigrationRepository } from '../infrastructure/taxonomy-migration.repository.js';
import {
  CreateExamHandler,
  CreateProfileDraftHandler,
  PublishProfileVersionHandler,
  SupersedeProfileVersionHandler,
  UpdateProfileDraftHandler,
} from '../application/handlers/exam-profile-handlers.js';
import {
  AddConceptNodeHandler,
  AddPrerequisiteEdgeHandler,
  CreateTaxonomyDraftHandler,
  MoveConceptNodeHandler,
  PublishTaxonomyVersionHandler,
  RemoveConceptNodeHandler,
} from '../application/handlers/taxonomy-handlers.js';
import {
  AddMappingHandler,
  CreateMigrationHandler,
  ExecuteMigrationHandler,
  RunDryRunHandler,
  type MigrationExecutor,
} from '../application/handlers/migration-handlers.js';
import type { TaxonomyMapping } from '../domain/taxonomy-mapping.js';
import {
  GetConceptPrerequisitesQuery,
  GetConceptSubtreeQuery,
  GetExamProfilePinsQuery,
  GetExamProfileScoringSpecQuery,
  GetExamProfileVersionQuery,
  GetMigrationDryRunQuery,
  GetTaxonomyVersionQuery,
  ListExamsQuery,
  ListTaxonomyVersionsQuery,
} from '../application/queries/curriculum-queries.js';

/**
 * The composition seam (DEC-M0-5, ADR-0015). See `contexts/content/public/composition.ts`
 * for the fuller explanation this file follows exactly — `register` composes
 * curriculum's own handlers, repositories and adapters and returns the
 * `DynamicModule` `CurriculumModule.register` already produces.
 *
 * **`MigrationExecutor` has no cross-context adapter yet, and this is
 * honest about it rather than silent.** Migration execution retags content
 * and remaps mastery — work that reaches into other contexts' write paths —
 * and no milestone through M0 builds that adapter. `InMemoryMigrationExecutor`
 * below is a real, typed stand-in: `migratedConcepts` reports nothing done,
 * `migrateChunk` records what it was asked to apply and does nothing to
 * another context. `ExecuteMigrationHandler` composes and resolves with it,
 * so the route exists and boots; running an actual migration against it
 * would need the real adapter, not this one.
 */
export interface CurriculumCompositionDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
  readonly principals: PrincipalResolver;
}

const REQUIRED_DEPS_KEYS = [
  'pool',
  'clock',
  'identifiers',
  'audit',
  'principals',
] as const satisfies readonly (keyof CurriculumCompositionDeps)[];

export class InMemoryMigrationExecutor implements MigrationExecutor {
  readonly #applied = new Map<string, TaxonomyMapping[]>();

  async migratedConcepts(migrationId: string): Promise<readonly string[]> {
    return (this.#applied.get(migrationId) ?? []).flatMap((mapping) => mapping.conceptIds);
  }

  async migrateChunk(migrationId: string, mappings: readonly TaxonomyMapping[]): Promise<void> {
    const existing = this.#applied.get(migrationId) ?? [];
    this.#applied.set(migrationId, [...existing, ...mappings]);
  }
}

function assemble(deps: CurriculumCompositionDeps) {
  for (const key of REQUIRED_DEPS_KEYS) {
    if (deps[key] === undefined) {
      throw new Error(`curriculum composition is missing required dependency: ${key}`);
    }
  }

  const db = drizzle(deps.pool);
  const exams = new DrizzleExamRepository(db);
  const profiles = new DrizzleExamProfileVersionRepository(db);
  const versions = new DrizzleTaxonomyVersionRepository(db);
  const identities = new DrizzleConceptIdentityRepository(db);
  const migrations = new DrizzleTaxonomyMigrationRepository(db);
  const executor = new InMemoryMigrationExecutor();

  const bag = {
    exams,
    profiles,
    versions,
    identities,
    migrations,
    executor,
    audit: deps.audit,
    clock: deps.clock,
    identifiers: deps.identifiers,
  };

  return bag;
}

export function register(deps: CurriculumCompositionDeps): DynamicModule {
  const bag = assemble(deps);

  const handlers = [
    // Exam & profile
    new CreateExamHandler(bag),
    new CreateProfileDraftHandler(bag),
    new UpdateProfileDraftHandler(bag),
    new PublishProfileVersionHandler(bag),
    new SupersedeProfileVersionHandler(bag),
    // Taxonomy
    new CreateTaxonomyDraftHandler(bag),
    new AddConceptNodeHandler(bag),
    new MoveConceptNodeHandler(bag),
    new RemoveConceptNodeHandler(bag),
    new AddPrerequisiteEdgeHandler(bag),
    new PublishTaxonomyVersionHandler(bag),
    // Migration
    new CreateMigrationHandler(bag),
    new AddMappingHandler(bag),
    new RunDryRunHandler(bag),
    new ExecuteMigrationHandler(bag),
    // Queries
    new GetTaxonomyVersionQuery(bag),
    new ListTaxonomyVersionsQuery(bag),
    new GetConceptSubtreeQuery(bag),
    new GetConceptPrerequisitesQuery(bag),
    new GetExamProfileVersionQuery(bag),
    new ListExamsQuery(bag),
    new GetMigrationDryRunQuery(bag),
  ] as unknown as readonly Handler<never, unknown>[];

  return CurriculumModule.register({ handlers, principals: deps.principals });
}

/**
 * What generation consumes from curriculum, and nothing more: the one read that
 * says which concepts a taxonomy version contains and whether it is in force
 * (M5-37). Curriculum admits the generation pipeline to this query alone (D43,
 * closed), and the handler is built from the same assembly `register` uses.
 *
 * Content's counterpart, `contentForGeneration`, explains why a context names
 * what another may call and does not let the composition root reach into its module.
 */
export interface CurriculumForGeneration {
  readonly taxonomyVersion: GetTaxonomyVersionQuery;
}

export function curriculumForGeneration(deps: CurriculumCompositionDeps): CurriculumForGeneration {
  return { taxonomyVersion: new GetTaxonomyVersionQuery(assemble(deps)) };
}

/**
 * What assessment consumes from curriculum: the pins an attempt copies from an exam profile
 * version (M6-30). Read-only, built from the same assembly `register` uses, and handed over by
 * the composition root — assessment imports nothing from curriculum.
 */
export interface CurriculumForAssessment {
  readonly examProfilePins: GetExamProfilePinsQuery;
  /** The marking rules and aggregation scoring applies, for the system's scoring consumer alone (M6-40). */
  readonly scoringSpec: GetExamProfileScoringSpecQuery;
}

export function curriculumForAssessment(deps: CurriculumCompositionDeps): CurriculumForAssessment {
  const bag = assemble(deps);
  return { examProfilePins: new GetExamProfilePinsQuery(bag), scoringSpec: new GetExamProfileScoringSpecQuery(bag) };
}
