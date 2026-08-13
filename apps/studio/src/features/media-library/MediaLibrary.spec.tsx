import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { accessibilityViolations } from '../../testing/accessibility.js';
import { MediaLibrary } from './MediaLibrary.js';
import {
  ASSET_TYPES,
  INFORMATION_BEARING_ASSET_TYPES,
  MEDIA_FORM_ERROR_CODES,
  registrationBlockers,
  requiresLongDescription,
  type MediaAssetSummary,
  type MediaLibraryApi,
  type StoredObject,
  type UsageEntry,
} from './media-library-model.js';

const STORED: StoredObject = {
  storageKey: 'media/019fd4bc/lift-fbd.png',
  mimeType: 'image/png',
  width: 800,
  height: 600,
};

const IN_USE: MediaAssetSummary = {
  assetId: 'asset-1',
  assetType: 'diagram',
  altText: 'Free-body diagram of a lift',
  referencingPublishedCount: 2,
};

const UNUSED: MediaAssetSummary = {
  assetId: 'asset-2',
  assetType: 'photograph',
  altText: 'A laboratory balance',
  referencingPublishedCount: 0,
};

interface Registered {
  readonly assetType: string;
  readonly altText: string;
  readonly longDescription: string | null;
  readonly storageKey: string;
}

function harness(options: {
  readonly assets?: readonly MediaAssetSummary[];
  readonly usage?: readonly UsageEntry[];
  readonly retireRefusal?: string;
} = {}): {
  readonly api: MediaLibraryApi;
  readonly registered: Registered[];
  readonly retired: string[];
} {
  const registered: Registered[] = [];
  const retired: string[] = [];

  const api: MediaLibraryApi = {
    async list() {
      return options.assets ?? [];
    },
    async usage() {
      return options.usage ?? [];
    },
    async upload() {
      return STORED;
    },
    async register(input) {
      registered.push({
        assetType: input.assetType,
        altText: input.altText,
        longDescription: input.longDescription,
        storageKey: input.stored.storageKey,
      });
      return { assetId: 'asset-new' };
    },
    async retire(assetId) {
      if (options.retireRefusal !== undefined) {
        return { ok: false, message: options.retireRefusal };
      }
      retired.push(assetId);
      return { ok: true };
    },
  };

  return { api, registered, retired };
}

function renderLibrary(
  api: MediaLibraryApi,
  overrides: Partial<Parameters<typeof MediaLibrary>[0]> = {},
) {
  return render(<MediaLibrary api={api} principalMayManageMedia {...overrides} />);
}

function pngFile(): File {
  return new File(['not really a png'], 'lift-fbd.png', { type: 'image/png' });
}

describe('the asset-type vocabulary is the generated one', () => {
  it('classifies every asset type as information-bearing or not', () => {
    const decorative = ASSET_TYPES.filter(
      (type) => !(INFORMATION_BEARING_ASSET_TYPES as readonly string[]).includes(type),
    );
    // A type added to the OpenAPI document lands here unclassified and fails,
    // rather than silently defaulting to "needs no long description".
    expect(decorative).toEqual(['photograph']);
    expect(ASSET_TYPES.length).toBeGreaterThan(1);
  });

  it('requires a long description for everything that carries information (ACC-03)', () => {
    for (const type of ASSET_TYPES) {
      expect(requiresLongDescription(type), type).toBe(type !== 'photograph');
    }
  });
});

describe('registration blockers', () => {
  it('reports every reason at once, from the closed list', () => {
    const blockers = registrationBlockers({
      assetType: 'chart',
      stored: null,
      altText: '   ',
      longDescription: '',
    });
    expect(blockers.map((blocker) => blocker.code)).toEqual([
      'OBJECT_NOT_UPLOADED',
      'ALT_TEXT_REQUIRED',
      'LONG_DESCRIPTION_REQUIRED',
    ]);
    for (const blocker of blockers) expect(MEDIA_FORM_ERROR_CODES).toContain(blocker.code);
  });

  it('does not ask a photograph for a long description', () => {
    expect(
      registrationBlockers({
        assetType: 'photograph',
        stored: STORED,
        altText: 'A laboratory balance',
        longDescription: '',
      }),
    ).toEqual([]);
  });
});

describe('alt text cannot be skipped (FR-QM-06, ACC-03)', () => {
  // Not validated after the upload: the action itself is unavailable, so an
  // asset without a description never exists to be referenced.
  it('keeps the register action unavailable until alt text is there', async () => {
    const user = userEvent.setup();
    const { api, registered } = harness();
    renderLibrary(api);

    await user.upload(screen.getByLabelText('Image file'), pngFile());
    await waitFor(() => expect(screen.getByText(/Stored as media/u)).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Register asset' })).toBeDisabled();
    await user.type(screen.getByLabelText('Alt text'), 'A laboratory balance');
    expect(screen.getByRole('button', { name: 'Register asset' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Register asset' }));
    expect(registered).toEqual([
      {
        assetType: 'photograph',
        altText: 'A laboratory balance',
        longDescription: null,
        storageKey: STORED.storageKey,
      },
    ]);
  });

  it('says what registration is still waiting for, and links to the field', async () => {
    const user = userEvent.setup();
    renderLibrary(harness().api);

    await user.upload(screen.getByLabelText('Image file'), pngFile());
    const waiting = screen.getByRole('list', { name: 'What registration still needs' });
    expect(within(waiting).getByRole('link', { name: /Alt text is required/u })).toHaveAttribute(
      'href',
      '#media-alt-text',
    );
  });

  it('will not register before anything has been uploaded', () => {
    renderLibrary(harness().api);
    expect(screen.getByRole('button', { name: 'Register asset' })).toBeDisabled();
    expect(screen.getByText('Choose a file first.')).toBeInTheDocument();
  });
});

describe('a complex asset needs a long description as well', () => {
  it('asks for one, and refuses registration until it is there', async () => {
    const user = userEvent.setup();
    const { api, registered } = harness();
    renderLibrary(api);

    await user.upload(screen.getByLabelText('Image file'), pngFile());
    await user.type(screen.getByLabelText('Alt text'), 'Free-body diagram of a lift');
    expect(screen.getByRole('button', { name: 'Register asset' })).toBeEnabled();

    await user.selectOptions(screen.getByLabelText('Asset type'), 'diagram');
    expect(screen.getByRole('button', { name: 'Register asset' })).toBeDisabled();
    expect(screen.getByText(/A diagram carries information/u)).toBeInTheDocument();

    await user.type(
      screen.getByLabelText('Long description'),
      'Weight acts down, normal force up, net force upward.',
    );
    await user.click(screen.getByRole('button', { name: 'Register asset' }));

    expect(registered[0]?.longDescription).toBe(
      'Weight acts down, normal force up, net force upward.',
    );
  });

  it('offers no long-description field for a photograph', async () => {
    const user = userEvent.setup();
    renderLibrary(harness().api);

    expect(screen.queryByLabelText('Long description')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Asset type'), 'chart');
    expect(screen.getByLabelText('Long description')).toBeInTheDocument();
  });
});

describe('the mime type comes from the store, never from the author (M3-27)', () => {
  it('reports what the store answered with and offers no type to declare', async () => {
    const user = userEvent.setup();
    renderLibrary(harness().api);

    await user.upload(screen.getByLabelText('Image file'), pngFile());
    await waitFor(() =>
      expect(
        screen.getByText('Stored as media/019fd4bc/lift-fbd.png — image/png, 800×600.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText(/mime/iu)).toBeNull();
  });
});

describe('the usage graph is visible (M3-24)', () => {
  it('lists the published content referencing the asset', async () => {
    const user = userEvent.setup();
    const { api } = harness({
      assets: [IN_USE],
      usage: [
        { ownerType: 'item', ownerId: 'i1', label: 'Apparent weight in a lift' },
        { ownerType: 'solution', ownerId: 's1', label: 'Solution to the lift item' },
      ],
    });
    renderLibrary(api);

    await user.click(
      await screen.findByRole('button', {
        name: 'Free-body diagram of a lift — diagram, used by 2 published',
      }),
    );

    const list = screen.getByRole('list', { name: 'Published content using this asset' });
    expect(within(list).getAllByRole('listitem').map((entry) => entry.textContent)).toEqual([
      'item: Apparent weight in a lift',
      'solution: Solution to the lift item',
    ]);
  });

  it('says plainly when nothing published uses it', async () => {
    const user = userEvent.setup();
    renderLibrary(harness({ assets: [UNUSED] }).api);

    await user.click(
      await screen.findByRole('button', {
        name: 'A laboratory balance — photograph, used by 0 published',
      }),
    );
    expect(screen.getByText('No published content uses this asset.')).toBeInTheDocument();
  });

  it('designs the empty library rather than defaulting it', async () => {
    renderLibrary(harness().api);
    expect(await screen.findByText('No assets yet. Register the first one below.')).toBeInTheDocument();
  });
});

describe('retirement is refused, and the surface says why (FR-QM-06 rule 3)', () => {
  it('warns before the attempt that the domain will refuse', async () => {
    const user = userEvent.setup();
    renderLibrary(harness({ assets: [IN_USE] }).api);

    await user.click(
      await screen.findByRole('button', {
        name: 'Free-body diagram of a lift — diagram, used by 2 published',
      }),
    );
    expect(
      screen.getByText(
        'Retirement will be refused: 2 published item(s) still reference this asset.',
      ),
    ).toBeInTheDocument();
  });

  // Not disabled silently: an author who cannot act and cannot see why
  // concludes the tool is broken, and the domain's reason is the answer.
  it('leaves the action available and shows the domain refusal', async () => {
    const user = userEvent.setup();
    const { api, retired } = harness({
      assets: [IN_USE],
      retireRefusal: 'Refused: 2 published items reference this asset.',
    });
    renderLibrary(api);

    await user.click(
      await screen.findByRole('button', {
        name: 'Free-body diagram of a lift — diagram, used by 2 published',
      }),
    );

    const retireButton = screen.getByRole('button', { name: 'Retire this asset' });
    expect(retireButton).toBeEnabled();
    await user.click(retireButton);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Refused: 2 published items reference this asset.',
    );
    expect(retired).toEqual([]);
  });

  it('retires an asset nothing published uses', async () => {
    const user = userEvent.setup();
    const { api, retired } = harness({ assets: [UNUSED] });
    renderLibrary(api);

    await user.click(
      await screen.findByRole('button', {
        name: 'A laboratory balance — photograph, used by 0 published',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Retire this asset' }));

    expect(retired).toEqual(['asset-2']);
    expect(screen.getByRole('status')).toHaveTextContent('Asset retired.');
  });
});

describe('accessibility', () => {
  it('refuses a principal who may not manage media', () => {
    renderLibrary(harness().api, { principalMayManageMedia: false });
    expect(screen.getByRole('alert')).toHaveTextContent('not permitted to manage media assets');
    expect(screen.queryByLabelText('Image file')).toBeNull();
  });

  it('scans clean on an empty library', async () => {
    const { container } = renderLibrary(harness().api);
    expect(await screen.findByText('No assets yet. Register the first one below.')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean with an asset selected and a complex type chosen', async () => {
    const user = userEvent.setup();
    const { container } = renderLibrary(
      harness({
        assets: [IN_USE],
        usage: [{ ownerType: 'item', ownerId: 'i1', label: 'Apparent weight in a lift' }],
      }).api,
    );

    await user.click(
      await screen.findByRole('button', {
        name: 'Free-body diagram of a lift — diagram, used by 2 published',
      }),
    );
    await user.selectOptions(screen.getByLabelText('Asset type'), 'reaction_scheme');
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});
