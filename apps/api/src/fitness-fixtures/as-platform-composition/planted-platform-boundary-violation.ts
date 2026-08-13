// Planted violation for boundary-rules.spec.ts / app-factory.spec.ts (M0-12,
// F1 extended to `platform/`): a composition-root-shaped file reaching past
// a context's `public/` barrel into its `infrastructure/`, which is exactly
// what `platform/composition/app-factory.ts` must never do.
export { PostgresItemRepository } from '../../contexts/content/infrastructure/item.repository.js';
