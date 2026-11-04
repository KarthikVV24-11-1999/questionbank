import { main } from './demo-items.js';

// The `seed:items` entry point; `demo-items.ts` stays side-effect free so a test can import `seedDemoItems`.
await main();
