/**
 * `packages/content-renderer/` — the one `ContentRenderer` (§9 rule 13 / F20).
 *
 * Consumed by both the Studio preview and the learner surface, so what an
 * author sees is produced by the same code a student sees. It imports from
 * neither app (F19); the dependency points one way.
 */
export { ContentRenderer } from './content-renderer.js';
export type { ContentRendererProps, MediaResolution, RenderIssue } from './content-renderer.js';

export {
  BLOCK_KINDS,
  CONTENT_BODY_SCHEMA_VERSION,
  INLINE_KINDS,
  MEDIA_SIZE_HINTS,
  TEXT_MARKS,
  isBlockKind,
  isInlineKind,
} from './content-body.js';
export type {
  Block,
  BlockKind,
  ContentBody,
  Inline,
  InlineKind,
  MediaSizeHint,
  TextMark,
} from './content-body.js';

export {
  MINIMUM_DEVICE_PROFILE,
  PROFILE_WIDTH,
  SURFACE_PROFILES,
  isSurfaceProfile,
} from './surface-profile.js';
export type { SurfaceProfile } from './surface-profile.js';

export { ChemNode } from './chem-node.js';
export type { ChemNodeIssue, ChemNodeProps } from './chem-node.js';

export { chemToMathML } from './chem-to-mathml.js';
export type { ChemMLResult } from './chem-to-mathml.js';

export { MathNode, mathMLFor } from './math-node.js';
export type { MathNodeIssue, MathNodeProps } from './math-node.js';

export { latexToMathML } from './latex-to-mathml.js';
export type { MathMLResult } from './latex-to-mathml.js';

export {
  renderFor,
  rendersOnEverySurface,
  serializationsAgree,
  validateRender,
} from './render-validation.js';
export type { RenderValidationOptions, SurfaceVerdict } from './render-validation.js';

export { TOKENS } from './tokens.js';
