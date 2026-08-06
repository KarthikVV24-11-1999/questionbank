import { useCallback, useMemo, useState } from 'react';
import type { MappingKind, MigrationDryRun, TaxonomyVersionSummary } from '@questionbank/contracts';

export type Disposition = 'pending' | 'accepted' | 'rejected';

export interface ExecutionProgress {
  readonly migratedConceptCount: number;
  readonly totalConceptCount: number;
  readonly chunkCount: number;
  readonly finished: boolean;
}

export interface MigrationConsoleApi {
  listVersions(): Promise<readonly TaxonomyVersionSummary[]>;
  createMigration(fromVersionId: string, toVersionId: string): Promise<{ readonly migrationId: string }>;
  addMapping(
    migrationId: string,
    mapping: { readonly kind: MappingKind; readonly from: readonly string[]; readonly to: readonly string[] },
  ): Promise<void>;
  runDryRun(migrationId: string): Promise<MigrationDryRun>;
  disposition(migrationId: string, exceptionIndex: number, disposition: Disposition): Promise<void>;
  execute(migrationId: string, onProgress: (progress: ExecutionProgress) => void): Promise<void>;
}

export interface MigrationConsoleProps {
  readonly api: MigrationConsoleApi;
}

const CONFIRMATION_PHRASE = 'MIGRATE';

/**
 * Runs a taxonomy migration safely (M1-35): dry run first, every exception
 * dispositioned, then a typed confirmation before anything executes.
 */
export function MigrationConsole({ api }: MigrationConsoleProps) {
  const [versions, setVersions] = useState<readonly TaxonomyVersionSummary[]>([]);
  const [fromVersionId, setFromVersionId] = useState('');
  const [toVersionId, setToVersionId] = useState('');
  const [migrationId, setMigrationId] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<MigrationDryRun | null>(null);
  const [dispositions, setDispositions] = useState<readonly Disposition[]>([]);
  const [confirmation, setConfirmation] = useState('');
  const [progress, setProgress] = useState<ExecutionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadVersions = useCallback(async () => {
    setVersions(await api.listVersions());
  }, [api]);

  const start = useCallback(async () => {
    if (fromVersionId === '' || toVersionId === '') {
      setError('Choose a source and a target version.');
      return;
    }
    if (fromVersionId === toVersionId) {
      setError('A migration runs between two different versions.');
      return;
    }

    setError(null);
    const created = await api.createMigration(fromVersionId, toVersionId);
    setMigrationId(created.migrationId);
    setDryRun(null);
    setDispositions([]);
    setProgress(null);
  }, [api, fromVersionId, toVersionId]);

  const runDryRun = useCallback(async () => {
    if (migrationId === null) return;

    const result = await api.runDryRun(migrationId);
    setDryRun(result);
    setDispositions(result.exceptions.map((exception) => exception.disposition));
  }, [api, migrationId]);

  const setDisposition = useCallback(
    async (index: number, disposition: Disposition) => {
      if (migrationId === null) return;
      await api.disposition(migrationId, index, disposition);
      setDispositions((current) => current.map((existing, position) => (position === index ? disposition : existing)));
    },
    [api, migrationId],
  );

  const allDispositioned = useMemo(
    () => dryRun !== null && dispositions.every((disposition) => disposition !== 'pending'),
    [dispositions, dryRun],
  );
  const confirmed = confirmation.trim() === CONFIRMATION_PHRASE;
  const canExecute = dryRun !== null && allDispositioned && confirmed && progress?.finished !== true;

  const execute = useCallback(async () => {
    if (migrationId === null || !canExecute) return;
    await api.execute(migrationId, setProgress);
  }, [api, canExecute, migrationId]);

  return (
    <main>
      <h1>Taxonomy migration</h1>
      {error !== null ? <p role="alert">{error}</p> : null}

      <section aria-labelledby="versions-heading">
        <h2 id="versions-heading">Versions</h2>
        <button type="button" onClick={() => void loadVersions()}>
          Load versions
        </button>

        <label htmlFor="from-version">Migrate from</label>
        <select id="from-version" value={fromVersionId} onChange={(event) => setFromVersionId(event.target.value)}>
          <option value="">Choose a version…</option>
          {versions.map((version) => (
            <option key={version.taxonomyVersionId} value={version.taxonomyVersionId}>
              {version.examFamily} {version.academicYear}
            </option>
          ))}
        </select>

        <label htmlFor="to-version">Migrate to</label>
        <select id="to-version" value={toVersionId} onChange={(event) => setToVersionId(event.target.value)}>
          <option value="">Choose a version…</option>
          {versions.map((version) => (
            <option key={version.taxonomyVersionId} value={version.taxonomyVersionId}>
              {version.examFamily} {version.academicYear}
            </option>
          ))}
        </select>

        <button type="button" onClick={() => void start()}>
          Create migration
        </button>
      </section>

      {migrationId === null ? null : (
        <section aria-labelledby="dry-run-heading">
          <h2 id="dry-run-heading">Dry run</h2>
          <button type="button" onClick={() => void runDryRun()}>
            Run dry run
          </button>

          {dryRun === null ? (
            <p role="status">Run a dry run to see what this migration would do.</p>
          ) : (
            <>
              <p>
                {dryRun.autoMigratableCount} concept
                {dryRun.autoMigratableCount === 1 ? '' : 's'} migrate automatically.{' '}
                {dryRun.exceptions.length} need
                {dryRun.exceptions.length === 1 ? 's' : ''} a decision.
              </p>

              {dryRun.invalidMappings.length > 0 ? (
                <p role="alert">
                  {dryRun.invalidMappings.length} mapping
                  {dryRun.invalidMappings.length === 1 ? '' : 's'} reference concepts that are no longer
                  present. Fix them before executing.
                </p>
              ) : null}

              <table>
                <caption>Exceptions requiring a decision</caption>
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col">Concepts</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {dryRun.exceptions.map((exception, index) => (
                    <tr key={`${exception.kind}:${exception.concepts.join(',')}`}>
                      <td>{exception.kind}</td>
                      <td>{exception.concepts.join(', ')}</td>
                      <td>{exception.reason}</td>
                      <td>
                        <label htmlFor={`disposition-${index}`}>
                          Decision for {exception.concepts.join(', ')}
                        </label>
                        <select
                          id={`disposition-${index}`}
                          value={dispositions[index] ?? 'pending'}
                          onChange={(event) =>
                            void setDisposition(index, event.target.value as Disposition)
                          }
                        >
                          <option value="pending">Undecided</option>
                          <option value="accepted">Accept</option>
                          <option value="rejected">Reject</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {dryRun === null ? null : (
        <section aria-labelledby="execute-heading">
          <h2 id="execute-heading">Execute</h2>

          {allDispositioned ? null : (
            <p role="status">
              Every exception needs a decision before this migration can run.
            </p>
          )}

          <label htmlFor="confirmation">Type {CONFIRMATION_PHRASE} to confirm</label>
          <input
            id="confirmation"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={!allDispositioned}
          />

          <button type="button" onClick={() => void execute()} disabled={!canExecute}>
            Execute migration
          </button>

          {progress === null ? null : (
            <div>
              <progress
                aria-label="Migration progress"
                value={progress.migratedConceptCount}
                max={progress.totalConceptCount}
              />
              <p role="status">
                {progress.finished
                  ? `Migration complete: ${progress.migratedConceptCount} concepts in ${progress.chunkCount} chunks.`
                  : `Migrated ${progress.migratedConceptCount} of ${progress.totalConceptCount} concepts.`}
              </p>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
