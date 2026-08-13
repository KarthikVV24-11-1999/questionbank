import { validateRender } from '@questionbank/content-renderer/render-validation';
import type { ItemVersion } from '../domain/item-version.js';
import type { RenderVerdict } from '../domain/publication-preconditions.js';
import type { RenderValidator } from '../application/ports.js';

/**
 * Closes **D27**. `application/ports.ts` named this "a composition gap
 * rather than a design one" — `validateRender` already produced exactly the
 * verdict M3-11's publication precondition needs; what was missing was
 * something to call it from the API, and the API being able to type-check
 * that call at all (ADR-0016 — `renderFor` calls `ContentRenderer(...)`,
 * defined in `content-renderer.tsx`, so this file's own import chain is
 * what needed `apps/api/tsconfig.json`'s `jsx` option, not any JSX written
 * here).
 *
 * **No rendering logic lives here, and no JSX.** This file maps
 * `ItemVersion` to the `ContentBody` `validateRender` expects, calls it, and
 * maps the four `SurfaceVerdict`s back onto the one `RenderVerdict` shape
 * the domain names — plain TypeScript throughout. F20 (exactly one
 * `ContentRenderer` implementation) is unaffected because nothing here
 * constructs one, and `checkNoTsxFiles` (ADR-0016) asserts this file, and
 * every file under `apps/api/src/`, stays that way.
 *
 * `version.stem` (content's own `ContentBody`) is passed to the renderer's
 * `validateRender`, which declares its own, independently-declared
 * `ContentBody` parameter type. The two are proven identical in shape by
 * `renderer-seam.spec.ts` — this file relies on that seam rather than
 * re-asserting it, on the same argument every other cross-package boundary
 * in this repository takes.
 *
 * **A failure on any surface blocks.** `render-validation.ts` already
 * documents that "a failure on any supported surface blocks publication.
 * Not a warning" — this adapter reports every surface's failures without
 * filtering or softening any of them.
 */
export class RenderValidatorAdapter implements RenderValidator {
  async validate(version: ItemVersion): Promise<RenderVerdict> {
    const verdicts = validateRender(version.stem);
    return {
      itemVersionId: version.versionId,
      surfacesChecked: verdicts.map((verdict) => verdict.surface),
      failures: verdicts.flatMap((verdict) => verdict.failures),
    };
  }
}
