import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MigrationDryRun } from '@questionbank/contracts';
import { MigrationConsole, type MigrationConsoleApi } from './MigrationConsole.js';
import { A_DRAFT_VERSION, A_PUBLISHED_VERSION } from '../../testing/fake-curriculum-client.js';
import { accessibilityViolations } from '../../testing/accessibility.js';

const DRY_RUN: MigrationDryRun = {
  schemaVersion: 1,
  migrationId: 'mig-1',
  fromVersionId: A_PUBLISHED_VERSION.taxonomyVersionId,
  toVersionId: A_DRAFT_VERSION.taxonomyVersionId,
  autoMigratableCount: 12,
  exceptions: [
    {
      kind: 'AMBIGUOUS_MAPPING',
      mappingKind: 'SPLIT',
      concepts: ['ci-optics', 'ci-ray-optics', 'ci-wave-optics'],
      disposition: 'pending',
      reason: 'SPLIT cannot be applied without human disposition',
    },
    {
      kind: 'UNMAPPED',
      concepts: ['ci-thermo'],
      disposition: 'pending',
      reason: 'concept exists in the source version but no mapping covers it',
    },
  ],
  invalidMappings: [],
};

function fakeApi(overrides: Partial<MigrationConsoleApi> = {}): MigrationConsoleApi {
  return {
    listVersions: vi.fn(async () => [A_PUBLISHED_VERSION, A_DRAFT_VERSION]),
    createMigration: vi.fn(async () => ({ migrationId: 'mig-1' })),
    addMapping: vi.fn(async () => undefined),
    runDryRun: vi.fn(async () => DRY_RUN),
    disposition: vi.fn(async () => undefined),
    execute: vi.fn(async (_migrationId, onProgress) => {
      onProgress({ migratedConceptCount: 6, totalConceptCount: 12, chunkCount: 1, finished: false });
      onProgress({ migratedConceptCount: 12, totalConceptCount: 12, chunkCount: 2, finished: true });
    }),
    ...overrides,
  };
}

function renderConsole(api = fakeApi()) {
  const view = render(<MigrationConsole api={api} />);
  return { api, ...view };
}

async function createMigration(api = fakeApi()) {
  const view = renderConsole(api);
  await userEvent.click(screen.getByRole('button', { name: 'Load versions' }));
  await userEvent.selectOptions(screen.getByLabelText('Migrate from'), [
    A_PUBLISHED_VERSION.taxonomyVersionId,
  ]);
  await userEvent.selectOptions(screen.getByLabelText('Migrate to'), [
    A_DRAFT_VERSION.taxonomyVersionId,
  ]);
  await userEvent.click(screen.getByRole('button', { name: 'Create migration' }));
  return view;
}

async function dispositionAll(): Promise<void> {
  await userEvent.selectOptions(screen.getByLabelText(/Decision for ci-optics/u), ['accepted']);
  await userEvent.selectOptions(screen.getByLabelText(/Decision for ci-thermo/u), ['rejected']);
}

describe('selecting versions', () => {
  it('creates a migration between two versions', async () => {
    const { api } = await createMigration();

    expect(api.createMigration).toHaveBeenCalledWith(
      A_PUBLISHED_VERSION.taxonomyVersionId,
      A_DRAFT_VERSION.taxonomyVersionId,
    );
    expect(screen.getByRole('heading', { name: 'Dry run' })).toBeInTheDocument();
  });

  it('refuses a migration from a version to itself', async () => {
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Load versions' }));
    await userEvent.selectOptions(screen.getByLabelText('Migrate from'), [
      A_PUBLISHED_VERSION.taxonomyVersionId,
    ]);
    await userEvent.selectOptions(screen.getByLabelText('Migrate to'), [
      A_PUBLISHED_VERSION.taxonomyVersionId,
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Create migration' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/two different versions/u);
  });

  it('refuses a migration with a version unchosen', async () => {
    renderConsole();
    await userEvent.click(screen.getByRole('button', { name: 'Load versions' }));

    await userEvent.click(screen.getByRole('button', { name: 'Create migration' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/Choose a source and a target/u);
  });
});

describe('dry run results are shown before execution is offered', () => {
  it('offers no execute section until a dry run has been run', async () => {
    await createMigration();

    expect(screen.queryByRole('heading', { name: 'Execute' })).not.toBeInTheDocument();
    expect(screen.getByText(/Run a dry run to see what this migration would do/u)).toBeInTheDocument();
  });

  it('shows the auto-migratable count and the exception count', async () => {
    await createMigration();

    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));

    expect(screen.getByText(/12 concepts migrate automatically/u)).toBeInTheDocument();
    expect(screen.getByText(/2 need a decision/u)).toBeInTheDocument();
  });

  it('lists every exception with its kind, concepts and reason', async () => {
    await createMigration();

    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));

    const table = screen.getByRole('table', { name: 'Exceptions requiring a decision' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('AMBIGUOUS_MAPPING');
    expect(rows[0]).toHaveTextContent('ci-optics, ci-ray-optics, ci-wave-optics');
    expect(rows[1]).toHaveTextContent('UNMAPPED');
    expect(rows[1]).toHaveTextContent(/no mapping covers it/u);
  });

  it('warns when a mapping has gone stale', async () => {
    const api = fakeApi({
      runDryRun: vi.fn(async () => ({
        ...DRY_RUN,
        invalidMappings: [
          { mappingIndex: 0, mappingKind: 'SPLIT' as const, concepts: ['ci-gone'], reason: 'absent' },
        ],
      })),
    });
    await createMigration(api);

    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/no longer present/u);
  });
});

describe('execution is gated on disposition and typed confirmation', () => {
  it('blocks execution while any exception is undecided', async () => {
    await createMigration();
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));

    expect(screen.getByRole('button', { name: 'Execute migration' })).toBeDisabled();
    expect(screen.getByLabelText(/Type MIGRATE to confirm/u)).toBeDisabled();
    expect(screen.getByText(/Every exception needs a decision/u)).toBeInTheDocument();
  });

  it('still blocks execution when only some exceptions are decided', async () => {
    await createMigration();
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));

    await userEvent.selectOptions(screen.getByLabelText(/Decision for ci-optics/u), ['accepted']);

    expect(screen.getByRole('button', { name: 'Execute migration' })).toBeDisabled();
  });

  it('records each disposition against the migration', async () => {
    const { api } = await createMigration();
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));

    await dispositionAll();

    expect(api.disposition).toHaveBeenCalledWith('mig-1', 0, 'accepted');
    expect(api.disposition).toHaveBeenCalledWith('mig-1', 1, 'rejected');
  });

  it('requires the typed confirmation, not just a click', async () => {
    await createMigration();
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
    await dispositionAll();

    expect(screen.getByRole('button', { name: 'Execute migration' })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/Type MIGRATE to confirm/u), 'migrate');
    expect(screen.getByRole('button', { name: 'Execute migration' })).toBeDisabled();

    await userEvent.clear(screen.getByLabelText(/Type MIGRATE to confirm/u));
    await userEvent.type(screen.getByLabelText(/Type MIGRATE to confirm/u), 'MIGRATE');
    expect(screen.getByRole('button', { name: 'Execute migration' })).toBeEnabled();
  });

  it('does not execute while the gate is closed', async () => {
    const { api } = await createMigration();
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));

    await userEvent.click(screen.getByRole('button', { name: 'Execute migration' }));

    expect(api.execute).not.toHaveBeenCalled();
  });
});

describe('chunked execution progress', () => {
  it('shows progress and then completion', async () => {
    const { api } = await createMigration();
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
    await dispositionAll();
    await userEvent.type(screen.getByLabelText(/Type MIGRATE to confirm/u), 'MIGRATE');

    await userEvent.click(screen.getByRole('button', { name: 'Execute migration' }));

    expect(api.execute).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('progressbar', { name: 'Migration progress' })).toHaveValue(12);
    expect(screen.getByText(/Migration complete: 12 concepts in 2 chunks/u)).toBeInTheDocument();
  });

  it('reports intermediate progress while chunks are running', async () => {
    const api = fakeApi({
      execute: vi.fn(async (_migrationId, onProgress) => {
        onProgress({ migratedConceptCount: 4, totalConceptCount: 12, chunkCount: 1, finished: false });
      }),
    });
    await createMigration(api);
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
    await dispositionAll();
    await userEvent.type(screen.getByLabelText(/Type MIGRATE to confirm/u), 'MIGRATE');

    await userEvent.click(screen.getByRole('button', { name: 'Execute migration' }));

    expect(screen.getByText(/Migrated 4 of 12 concepts/u)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Migration progress' })).toHaveValue(4);
  });

  it('disables execution once it has finished', async () => {
    await createMigration();
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
    await dispositionAll();
    await userEvent.type(screen.getByLabelText(/Type MIGRATE to confirm/u), 'MIGRATE');
    await userEvent.click(screen.getByRole('button', { name: 'Execute migration' }));

    expect(screen.getByRole('button', { name: 'Execute migration' })).toBeDisabled();
  });
});

describe('the full flow', () => {
  it('runs dry run → disposition → execute end to end', async () => {
    const { api } = await createMigration();

    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
    expect(api.runDryRun).toHaveBeenCalledWith('mig-1');

    await dispositionAll();
    await userEvent.type(screen.getByLabelText(/Type MIGRATE to confirm/u), 'MIGRATE');
    await userEvent.click(screen.getByRole('button', { name: 'Execute migration' }));

    expect(screen.getByText(/Migration complete/u)).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('passes the automated WCAG 2.2 AA scan with the exception list shown', async () => {
    const { container } = await createMigration();
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));

    expect(await accessibilityViolations(container)).toEqual([]);
  }, 30_000);

  it('passes the scan after execution', async () => {
    const { container } = await createMigration();
    await userEvent.click(screen.getByRole('button', { name: 'Run dry run' }));
    await dispositionAll();
    await userEvent.type(screen.getByLabelText(/Type MIGRATE to confirm/u), 'MIGRATE');
    await userEvent.click(screen.getByRole('button', { name: 'Execute migration' }));

    expect(await accessibilityViolations(container)).toEqual([]);
  }, 30_000);
});
