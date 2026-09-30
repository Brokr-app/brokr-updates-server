import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';

await build({ entryPoints: ['service/handler.mjs'], bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile: 'dist/handler.mjs',
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
await copyFile('certs/certificate.pem', 'dist/certificate.pem');
// Import the actual artifact to catch AWS SDK / ESM initialization failures before deployment.
await import('../dist/handler.mjs');
