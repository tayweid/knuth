// The inputs the built app is made from. Both halves of the freshness guard
// read this list, so "what counts as a change" is defined exactly once.

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const TREES = ['src', 'public'];
const FILES = ['index.html', 'vite.config.ts', 'tsconfig.json', 'package-lock.json'];
// Test corpora and unit tests do not reach the bundle.
const SKIP = /(\.test\.ts$|\/corpus\/)/;

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

  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    hash.update(path.slice(root.length));
    hash.update(await readFile(path));
  }
  return hash.digest('hex').slice(0, 16);
}

export const STAMP = new URL('../python/knuth/web/.sources', import.meta.url);
