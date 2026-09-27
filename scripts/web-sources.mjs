// The inputs the built app is made from. Both halves of the freshness guard
// read this list, so "what counts as a change" is defined exactly once.

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const TREES = ['src', 'public'];
const FILES = ['index.html', 'vite.config.ts', 'tsconfig.json', 'package-lock.json'];
// Test corpora and unit tests do not reach the bundle, and Finder's
// .DS_Store is on this Mac only: counting it made a stamp CI never matches.
const SKIP = /(\.test\.ts$|\/corpus\/|\/\.DS_Store$)/;
// The in-tab Python embeds engine modules as text (`import x from
// '../../python/knuth/env.py?raw'`), so those files are inputs too: a
// change to one of them changes the bundle without touching src/.
const RAW_IMPORT = /from\s+'((?:\.\.\/)+python\/[^']+\.py)\?raw'/g;

async function walk(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walk(path, found);
    else if (!SKIP.test(path)) found.push(path);
  }
  return found;
}

export async function sourceHash() {
  const root = fileURLToPath(ROOT);
  const paths = [];
  for (const tree of TREES) {
    try {
      await stat(`${root}${tree}`);
      paths.push(...(await walk(`${root}${tree}`)));
    } catch {
      continue;
    }
  }
  for (const file of FILES) paths.push(`${root}${file}`);
  for (const path of [...paths]) {
    if (!path.endsWith('.ts')) continue;
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(RAW_IMPORT)) {
      const embedded = resolve(dirname(path), match[1]);
      if (!paths.includes(embedded)) paths.push(embedded);
    }
  }

  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    hash.update(path.slice(root.length));
    hash.update(await readFile(path));
  }
  return hash.digest('hex').slice(0, 16);
}

export const STAMP = new URL('../python/knuth/web/.sources', import.meta.url);
