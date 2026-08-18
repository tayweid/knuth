// The built app is committed so `pip install` from this repo carries a UI.
// The cost of that is a way to ship a stale one: edit src/, forget to run
// `npm run build:engine`, and the package pairs new engine code with an old
// interface — the version skew this architecture exists to prevent, arriving
// through the build instead. Cheap to check, so check it.

import { readFile } from 'node:fs/promises';
import { STAMP, sourceHash } from './web-sources.mjs';

const expected = await sourceHash();
let stamped = null;
try {
  stamped = (await readFile(STAMP, 'utf8')).trim();
} catch {
  console.error('python/knuth/web/ has no build stamp — run `npm run build:engine`.');
  process.exit(1);
}

if (stamped !== expected) {
  console.error(
    'The committed app is older than the sources it is built from.\n' +
    `  stamped: ${stamped}\n  sources: ${expected}\n` +
    'Run `npm run build:engine` and commit python/knuth/web/.',
  );
  process.exit(1);
}
console.log(`committed app matches its sources (${expected})`);
