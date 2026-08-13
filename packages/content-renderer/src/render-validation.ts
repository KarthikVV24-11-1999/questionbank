import { renderToStaticMarkup } from 'react-dom/server';
import { ContentRenderer, type MediaResolution, type RenderIssue } from './content-renderer.js';
import type { ContentBody } from './content-body.js';
import { SURFACE_PROFILES, type SurfaceProfile } from './surface-profile.js';

/**
 * The render verdict M3-11's publication precondition consumes (FR-QM-14
 * rule 2, INV-14).
 *
 * **A failure on any supported surface blocks publication.** Not a warning:
 * an item that does not render on print is an item a student meets as a blank
 * space in an offline paper, and the person who finds out is the candidate.
 *
 * **Parity is asserted by construction, not by inspection.** The preview and
 * the delivery render are the *same call* — one component, one surface
 * parameter — so "byte-for-byte identical" is a property of there being one
 * code path, and `renderFor` is what both sides use. A test that rendered the
 * preview one way and delivery another would be testing two things it had
 * just written.
 */

export interface SurfaceVerdict {
  readonly surface: SurfaceProfile;
  readonly ok: boolean;
  readonly failures: readonly string[];
}

export interface RenderValidationOptions {
  readonly resolveMedia?: (assetVersionId: string) => MediaResolution | undefined;
}

/**
 * Serializes a document for one surface. **The one entry point** — the Studio
 * preview and the delivery render both come through here, which is what makes
 * the parity claim mean something.
 */
export function renderFor(
  body: ContentBody,
  surface: SurfaceProfile,
  options: RenderValidationOptions = {},
): { readonly html: string; readonly issues: readonly RenderIssue[] } {
  const issues: RenderIssue[] = [];
  const html = renderToStaticMarkup(
    ContentRenderer({
      body,
      surface,
      ...(options.resolveMedia === undefined ? {} : { resolveMedia: options.resolveMedia }),
      onIssue: (issue) => issues.push(issue),
    }),
  );
  return { html, issues };
}

/** A failure line the validation panel can point at (UX §10.1). */
function describe(issue: RenderIssue): string {
  return `${issue.location}: ${issue.message}`;
}

/**
 * Every supported surface, in the declared order.
 *
 * The verdict names the surface *and* the block index, because "it does not
 * render" is a message an author cannot act on — the same failure mode
 * "invalid item" has.
 */
export function validateRender(
  body: ContentBody,
  options: RenderValidationOptions = {},
): readonly SurfaceVerdict[] {
  return SURFACE_PROFILES.map((surface) => {
    const { issues } = renderFor(body, surface, options);
    // An unresolved figure is a *host* condition, not a document defect: the
    // same document renders once the asset resolves, so it must not block
    // publication of an item whose asset simply was not passed to a preview.
    const blocking = issues.filter((issue) => issue.code !== 'MEDIA_UNRESOLVED');
    return {
      surface,
      ok: blocking.length === 0,
      failures: blocking.map(describe),
    };
  });
}

/** True when every supported surface renders — what publication requires. */
export function rendersOnEverySurface(verdicts: readonly SurfaceVerdict[]): boolean {
  return verdicts.every((verdict) => verdict.ok);
}

/**
 * Compares two serializations of the same document for one surface.
 *
 * Deliberately takes both sides rather than producing them: a function that
 * called `renderFor` twice and compared the results would be a tautology
 * dressed as a parity check. What the spec does instead is hand it the real
 * render and a **planted divergence**, so the instrument is shown to fail
 * before it is trusted to pass.
 */
export function serializationsAgree(preview: string, delivery: string): boolean {
  return preview === delivery;
}
