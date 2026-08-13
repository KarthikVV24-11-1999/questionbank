import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ApiProblemError, type ApiClient, type RequestOptions } from '@questionbank/contracts/client';
import { accessibilityViolations } from '../../testing/accessibility.js';
import { ItemBrowser } from './ItemBrowser.js';
import { filtersFromSearch, filtersToSearch, NO_FILTERS, type SearchParamStore } from './item-browser-model.js';
import { createLiveItemBrowserApi } from './item-browser-api.js';

/**
 * M0-19 — the client-side half of the walking skeleton, against a **stubbed
 * transport** (component speed, no network). The real-API proof —
 * `createLiveItemBrowserApi` returning a draft a live seed created, through
 * the fully composed application — lives in `apps/api`'s own integration
 * project (`contexts/content/item-browser-live.integration.spec.ts`), the
 * only place in this repository able to both boot `createApplication` and
 * type-check `item-browser-api.ts` in the same program (see that file's own
 * header for why the dependency runs in that direction, not this one).
 */

function fakeSearchParams(initial = ''): SearchParamStore & { current(): string } {
  let value = initial;
  return {
    read: () => value,
    write: (search) => {
      value = search;
    },
    current: () => value,
  };
}

const AUTHOR_ID = '00000000-0000-4000-8000-0000000a0001';

const AN_AUTHORING_ITEM = {
  itemId: '00000000-0000-4000-8000-0000000e0001',
  itemType: 'SINGLE_CORRECT_MCQ',
  lifecycleState: 'draft',
  versions: [
    {
      versionId: '00000000-0000-4000-8000-0000000f0001',
      versionNo: 1,
      itemType: 'SINGLE_CORRECT_MCQ',
      stem: {
        schemaVersion: 1,
        blocks: [{ kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: 'A live-wired stem.', marks: [] }] }],
      },
      // No answer-key field here on purpose — the item browser is not on
      // ADR-0009's enumerated key-bearing feature list, and key-boundary.spec.ts
      // (src/authoring/) asserts that list is closed.
      responseSpec: { itemType: 'SINGLE_CORRECT_MCQ' },
      taxonomyTags: [],
      difficultyEstimate: 'moderate',
      provenance: { sourceType: 'original' },
      licensing: { status: 'unresolved' },
      authoredById: AUTHOR_ID,
      createdAt: '2026-08-13T10:00:00.000Z',
    },
  ],
};

function stubTransport(handler: (options: RequestOptions<unknown>) => unknown): ApiClient {
  return {
    request: (async <T,>(options: RequestOptions<T>) => handler(options as RequestOptions<unknown>) as T) as ApiClient['request'],
  };
}

function renderLiveBrowser(client: ApiClient, searchParams: SearchParamStore = fakeSearchParams()) {
  const api = createLiveItemBrowserApi({ baseUrl: 'https://api.example', getToken: () => null, myPrincipalId: AUTHOR_ID, client });
  return render(<ItemBrowser api={api} searchParams={searchParams} myPrincipalId={AUTHOR_ID} />);
}

describe('the live ItemBrowserApi — loading, empty and error states all render', () => {
  it('shows a loading state, then the seeded draft, mapped through the real port', async () => {
    const client = stubTransport(() => ({ items: [AN_AUTHORING_ITEM] }));
    renderLiveBrowser(client);

    expect(screen.getByRole('status')).toHaveTextContent('Loading items…');
    expect(await screen.findByText(/A live-wired stem\. — draft/u)).toBeInTheDocument();
  });

  it('renders the designed empty state when the list is genuinely empty', async () => {
    const client = stubTransport(() => ({ items: [] }));
    renderLiveBrowser(client);

    expect(await screen.findByText('No items yet. The first draft you create will appear here.')).toBeInTheDocument();
  });

  it('renders the problem-details title on error — never a raw message, never SQL', async () => {
    const client = stubTransport(() => {
      throw new ApiProblemError({
        type: 'https://questionbank.example/problems/unavailable',
        title: 'Temporarily unavailable',
        status: 503,
        detail: 'relation "content.item" does not exist: SELECT * FROM content.item WHERE ...',
        code: 'Unavailable',
        retryable: true,
        correlationId: 'corr-1',
      });
    });
    renderLiveBrowser(client);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Temporarily unavailable');
    expect(alert.textContent).not.toMatch(/SELECT|relation|content\.item/u);
  });

  it('a non-problem transport failure still never leaks a raw message', async () => {
    const client = stubTransport(() => {
      throw new TypeError('fetch failed: getaddrinfo ENOTFOUND api.example');
    });
    renderLiveBrowser(client);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong loading items. Try again.');
    expect(alert.textContent).not.toContain('ENOTFOUND');
  });
});

describe('URL filters round-trip through the live port', () => {
  it('a filter applied in the UI is reflected in the URL, and reading it back reproduces the query', async () => {
    let capturedQuery: Readonly<Record<string, string | undefined>> | undefined;
    const client = stubTransport((options) => {
      capturedQuery = options.query;
      return { items: [] };
    });
    const store = fakeSearchParams('?state=draft');
    renderLiveBrowser(client, store);

    await waitFor(() => expect(capturedQuery?.['authorId']).toBe(AUTHOR_ID));
    expect(filtersToSearch(filtersFromSearch(store.current()))).toBe(store.current());
    expect(filtersFromSearch(store.current())).toEqual({ ...NO_FILTERS, lifecycleStates: ['draft'] });
  });
});

describe('accessibility', () => {
  it('the loading and populated states scan clean', async () => {
    const client = stubTransport(() => ({ items: [AN_AUTHORING_ITEM] }));
    const { container } = renderLiveBrowser(client);
    await screen.findByText(/A live-wired stem\./u);
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});
