# @questionbank/content-renderer

The one `ContentRenderer` implementation in the repository. Takes a `ContentBody` document (the closed,
versioned node vocabulary content authors write against — never rendered markup, never an image of text) and
a `SurfaceProfile` (`web | mobile | offline | print`), and renders it. Both the Studio authoring preview and
student delivery consume this same package — never two renderers — which is what makes "preview matches
student render byte-for-byte" a provable claim (F20) rather than an aspiration. Mathematical and chemical
notation render as real MathML, not an image or a styled approximation.

## How to run it

This is a library, not a runnable application — it is consumed by `@questionbank/studio` and (from M6) the
learner-facing app. There is nothing to start directly; see those packages for how they use it.

## How to test it

```bash
corepack pnpm typecheck
corepack pnpm test   # vitest + jsdom
```

Tests render fixture `ContentBody` documents per node kind and per surface profile, assert MathML output and
its accessible name (the authored `textAlternative`, never the raw LaTeX), assert byte-identical output across
repeated renders and across profiles, and run an `axe-core` scan over representative output.
