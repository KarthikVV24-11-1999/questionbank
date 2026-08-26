import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { accessibilityViolations } from '../testing/accessibility.js';
import { StudioShell } from './StudioShell.js';
import { ViewportGate } from './viewport-gate.js';
import { DESTINATIONS, MINIMUM_VIEWPORT_WIDTH, destinationById, filterDestinations } from './navigation.js';

function renderShell(overrides: Partial<Parameters<typeof StudioShell>[0]> = {}) {
  const onNavigate = vi.fn();
  const result = render(
    <StudioShell
      viewportWidth={1440}
      activeDestinationId="authoring"
      onNavigate={onNavigate}
      {...overrides}
    >
      <p>the authoring surface</p>
    </StudioShell>,
  );
  return { ...result, onNavigate };
}

describe('the 1280 px gate (FRONTEND §2, §9)', () => {
  // Asserted at the boundary itself, because an off-by-one here is a Studio
  // that refuses to open on the exact screen it was specified for.
  it('gates at 1279 and does not at 1280', () => {
    const gated = render(
      <ViewportGate width={MINIMUM_VIEWPORT_WIDTH - 1}>
        <p>authoring</p>
      </ViewportGate>,
    );
    expect(gated.getByRole('alert')).toHaveTextContent('Use a larger screen');
    expect(gated.queryByText('authoring')).toBeNull();

    const open = render(
      <ViewportGate width={MINIMUM_VIEWPORT_WIDTH}>
        <p>authoring</p>
      </ViewportGate>,
    );
    expect(open.getByText('authoring')).toBeInTheDocument();
  });

  // Not a responsive squeeze: the surface must be *absent*, or an answer key
  // is on a screen somebody is holding on a train.
  it('renders no authoring surface at all below the floor', () => {
    renderShell({ viewportWidth: 800 });
    expect(screen.queryByText('the authoring surface')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('says how wide the window actually is, so the message is actionable', () => {
    render(
      <ViewportGate width={1024}>
        <p>authoring</p>
      </ViewportGate>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('1024');
  });
});

describe('the sidebar (FRONTEND §2)', () => {
  it('lists every destination, live and pending alike', () => {
    renderShell();
    const sidebar = screen.getByRole('navigation', { name: 'Studio sections' });
    for (const destination of DESTINATIONS) {
      expect(within(sidebar).getByRole('button', { name: destination.label })).toBeInTheDocument();
    }
  });

  // A navigation model that grows by enabling is reviewable; one that grows by
  // appearing is not.
  it('announces a pending destination as disabled, with the reason', () => {
    renderShell();
    const pending = screen.getByRole('button', { name: 'Content Health' });
    expect(pending).toHaveAttribute('aria-disabled', 'true');
    expect(pending).toHaveAccessibleDescription('Arrives with content statistics');
  });

  it('marks the active destination as the current page', () => {
    renderShell({ activeDestinationId: 'taxonomy' });
    expect(screen.getByRole('button', { name: 'Taxonomy' })).toHaveAttribute('aria-current', 'page');
  });

  it('navigates on an enabled destination', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderShell();
    await user.click(screen.getByRole('button', { name: 'Taxonomy' }));
    expect(onNavigate).toHaveBeenCalledWith('taxonomy');
  });

  it('does not navigate on a disabled one', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderShell();
    await user.click(screen.getByRole('button', { name: 'Audit' }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  // A control that vanishes from the keyboard is one a keyboard user cannot
  // discover exists, so disabled destinations stay in the tab order.
  it('is fully keyboard-operable, including the disabled destinations', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderShell();

    // The shell has just moved focus to the `<h1>`, which sits in `main` —
    // after the sidebar in DOM order — so tabbing from there walks past every
    // destination. Release focus first and the traversal starts at the top of
    // the document, which is where a keyboard user arriving at the page is.
    (document.activeElement as HTMLElement | null)?.blur();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Dashboard' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Authoring' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Review Queue' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Queue Management' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Content Health' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('focus moves to the main heading on destination change (FRONTEND §10)', () => {
  it('focuses the heading on first render', () => {
    renderShell();
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });

  // Without this a screen-reader user is stranded on the sidebar item they
  // just activated, with nothing announcing that the page changed.
  it('focuses the new heading when the destination changes', () => {
    const { rerender } = renderShell();
    rerender(
      <StudioShell viewportWidth={1440} activeDestinationId="taxonomy" onNavigate={vi.fn()}>
        <p>the taxonomy surface</p>
      </StudioShell>,
    );
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Taxonomy');
    expect(heading).toHaveFocus();
  });
});

describe('the command palette (⌘K)', () => {
  it('opens on the shortcut and closes on Escape', async () => {
    const user = userEvent.setup();
    renderShell();

    expect(screen.queryByRole('dialog')).toBeNull();
    await user.keyboard('{Meta>}k{/Meta}');
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens on the control shortcut too, for a keyboard that has no meta key', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('toggles closed on a second press', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.keyboard('{Meta>}k{/Meta}');
    await user.keyboard('{Meta>}k{/Meta}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('filters the destination list as you type', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.keyboard('{Meta>}k{/Meta}');

    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Go to'), 'tax');

    expect(within(dialog).getByRole('button', { name: 'Taxonomy' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Authoring' })).toBeNull();
  });

  it('navigates from the palette and closes it', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderShell();
    await user.keyboard('{Meta>}k{/Meta}');

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Exams & Forms' }));
    expect(onNavigate).toHaveBeenCalledWith('exams');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('refuses a disabled destination from the palette as well', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderShell();
    await user.keyboard('{Meta>}k{/Meta}');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Users' }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('clears the query when it closes, so it reopens empty', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.keyboard('{Meta>}k{/Meta}');
    await user.type(within(screen.getByRole('dialog')).getByLabelText('Go to'), 'tax');
    await user.keyboard('{Escape}');
    await user.keyboard('{Meta>}k{/Meta}');

    expect(within(screen.getByRole('dialog')).getByLabelText('Go to')).toHaveValue('');
  });
});

describe('the route table is data, not a router (DEC-5)', () => {
  it('finds a destination by id, and nothing for an unknown one', () => {
    expect(destinationById('authoring')?.path).toBe('/authoring');
    expect(destinationById('nowhere')).toBeUndefined();
  });

  it('returns everything for an empty query', () => {
    expect(filterDestinations('   ')).toHaveLength(DESTINATIONS.length);
  });

  it('matches case-insensitively', () => {
    expect(filterDestinations('REVIEW').map((destination) => destination.id)).toEqual(['review-queue']);
  });

  it('gives every destination an accessible name and a path', () => {
    for (const destination of DESTINATIONS) {
      expect(destination.label.trim().length, destination.id).toBeGreaterThan(0);
      expect(destination.path.startsWith('/'), destination.id).toBe(true);
    }
  });

  it('gives every disabled destination a reason, and no enabled one a reason', () => {
    for (const destination of DESTINATIONS) {
      expect(destination.enabled ? destination.pendingReason === undefined : destination.pendingReason !== undefined, destination.id).toBe(true);
    }
  });

  // DEC-5, asserted rather than remembered: no router dependency in the
  // shell itself, even though M0-15 gave the app an entry point.
  // Read from the working directory, not from `import.meta.url`: Vite rewrites
  // a module URL to the path it *serves*, so `readFileSync` would be handed
  // `/src/shell/StudioShell.tsx` and the scan would fail for the wrong reason.
  // Studio's vitest runs with cwd = `apps/studio`.
  it('imports no router', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    const scanned: string[] = [];
    for (const file of ['StudioShell.tsx', 'navigation.ts', 'viewport-gate.tsx']) {
      const source = readFileSync(resolve('src/shell', file), 'utf8');
      expect(source, file).not.toMatch(/from '(react-router|@tanstack\/react-router|wouter)/u);
      scanned.push(file);
    }
    expect(scanned).toHaveLength(3);
  });

  // Was asserted absent under DEC-5 ("adding an entry point is M0's work").
  // M0-15 is that work — D3 is closed, and the application now has one.
  // Rewritten to assert presence rather than left asserting a falsehood
  // (M0's own DEC-M0-14 rule 3).
  it('has an application entry point (M0-15, closes D3)', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');

    for (const entryPoint of ['src/main.tsx', 'index.html', 'vite.config.ts']) {
      expect(existsSync(resolve(entryPoint)), entryPoint).toBe(true);
    }
  });
});

describe('accessibility', () => {
  it('scans clean with the shell open', async () => {
    const { container } = renderShell();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean with the palette open', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    await user.keyboard('{Meta>}k{/Meta}');
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean at the gate', async () => {
    const { container } = renderShell({ viewportWidth: 800 });
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});
