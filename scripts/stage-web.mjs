// Stage the built app into the Python package, so the engine can serve it
// from its own port (SAME_ORIGIN.md). Kept as an explicit step rather than a
// vite outDir so `npm run build` still produces a plain dist/ for Pages.

import { cp, rm, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
const staged = new URL('python/knuth/web/', root);

if (!existsSync(fileURLToPath(new URL('index.html', dist)))) {
  console.error('No dist/index.html — run `npm run build` first.');
  process.exit(1);
}

// Replace rather than merge: a stale fingerprinted asset left behind here
// would ship inside the wheel forever.
await rm(staged, { recursive: true, force: true });
await mkdir(staged, { recursive: true });
await cp(dist, staged, { recursive: true });

const entries = await readdir(staged, { recursive: true });
console.log(`staged ${entries.length} paths into python/knuth/web/`);
