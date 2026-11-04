// Builds the API for the image (M8-38): one bundle for the server and one for the migrator, with every dependency inside them.
//
// The workspace packages (`@questionbank/contracts`, `attempt-engine`, `domain-types`, `content-renderer`) export TypeScript source, and the application is
// run in development by `vite-node`, a development dependency. A production image needs neither, so the code is bundled by esbuild, with the same TypeScript
// settings the tests run under (the decorators the controllers use are the experimental kind, read from tsconfig.json). The few packages left outside are
// optional peers that NestJS reaches for only if a feature this application does not use is switched on.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  absWorkingDir: root,
  entryPoints: { server: 'src/main.ts', migrate: 'src/migrate.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  tsconfig: 'tsconfig.json',
  external: ['pg-native', '@nestjs/microservices', '@nestjs/websockets', '@nestjs/platform-socket.io', 'class-transformer', 'class-validator'],
  // bundled CommonJS packages call `require`, which an ES module does not have
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});
