import { main } from './index.js';

// The `pnpm seed` entry point. `index.ts` stays side-effect free so tests can
// import `seed()` without running it.
await main();
