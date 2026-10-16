import type { Pool } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import {
  createModelVersion,
  createPromptVersion,
  type ModelVersion,
  type PromptVersion,
} from '../domain/version-registry.js';
import type { RepositoryError, VersionRegistry } from '../domain/repository-ports.js';
import { fromDatabaseError, notFound, persistenceRejected } from './repository-errors.js';

interface ModelRow {
  readonly model_version_id: string;
  readonly provider_model_id: string;
  readonly automatic_upgrades_prohibited: boolean;
}

interface PromptRow {
  readonly prompt_version_id: string;
  readonly source_file: string;
  readonly content_sha256: string;
}

/**
 * The version registry over `ai.model_version` and `ai.prompt_version`. Written
 * at deploy and read thereafter; both tables are append-only.
 */
export class PostgresVersionRegistry implements VersionRegistry {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async registerModelVersion(version: ModelVersion): Promise<Result<ModelVersion, RepositoryError>> {
    try {
      await this.#pool.query(
        `INSERT INTO ai.model_version (model_version_id, provider_model_id, automatic_upgrades_prohibited)
         VALUES ($1, $2, $3)`,
        [version.modelVersionId, version.providerModelId, version.automaticUpgradesProhibited],
      );
      return ok(version);
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async registerPromptVersion(version: PromptVersion): Promise<Result<PromptVersion, RepositoryError>> {
    try {
      await this.#pool.query(
        `INSERT INTO ai.prompt_version (prompt_version_id, source_file, content_sha256) VALUES ($1, $2, $3)`,
        [version.promptVersionId, version.sourceFile, version.contentSha256],
      );
      return ok(version);
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async findModelVersion(modelVersionId: string): Promise<Result<ModelVersion, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<ModelRow>(
        `SELECT model_version_id, provider_model_id, automatic_upgrades_prohibited
           FROM ai.model_version WHERE model_version_id = $1`,
        [modelVersionId],
      );
      const row = rows[0];
      if (row === undefined) return err(notFound('model version', modelVersionId));

      const version = createModelVersion({
        modelVersionId: row.model_version_id,
        providerModelId: row.provider_model_id,
        automaticUpgradesProhibited: row.automatic_upgrades_prohibited,
      });
      return version.ok
        ? ok(version.value)
        : err(persistenceRejected(`stored model version ${modelVersionId} no longer satisfies the domain: ${version.error.code}`, version.error.location));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async findPromptVersion(promptVersionId: string): Promise<Result<PromptVersion, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<PromptRow>(
        `SELECT prompt_version_id, source_file, content_sha256 FROM ai.prompt_version WHERE prompt_version_id = $1`,
        [promptVersionId],
      );
      const row = rows[0];
      if (row === undefined) return err(notFound('prompt version', promptVersionId));

      const version = createPromptVersion({
        promptVersionId: row.prompt_version_id,
        sourceFile: row.source_file,
        contentSha256: row.content_sha256,
      });
      return version.ok
        ? ok(version.value)
        : err(persistenceRejected(`stored prompt version ${promptVersionId} no longer satisfies the domain: ${version.error.code}`, version.error.location));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }
}
