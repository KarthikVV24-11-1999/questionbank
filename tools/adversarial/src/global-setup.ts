import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

/**
 * The learner app is built before any run, so what a browser loads is the shipped bundle, not a dev server's rendering of the source.
 * `NODE_ENV` is set explicitly: a test runner sets it to `test`, and a build under that name bundles the development copy of React.
 */
export default function setup(): void {
  const learn = resolve(import.meta.dirname, '../../../apps/learn');
  execFileSync(join(learn, 'node_modules/.bin/vite'), ['build'], { cwd: learn, stdio: 'pipe', env: { ...process.env, NODE_ENV: 'production' } });
}
