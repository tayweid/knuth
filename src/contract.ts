// The folder contract written by the page through path-based file
// primitives — the TypeScript twin of python/knuth/contract.py, for the one
// case where no engine can write it: Knuth.app running Python in the tab,
// where the shell reads and writes files on the page's behalf (APP.md,
// "Built-in Python"). The ownership rule is the same as everywhere else:
// values.json wholesale, figs/<name>.svg for each named figure, and only
// figures the manifest says we wrote are ever deleted.

import {
  ARTIFACT_MANIFEST,
  isSafeFigureName,
  manifestText,
  parseOwnedFigureNames,
} from './artifacts.ts';

export interface PathIO {
  /** File text, or null when it does not exist or cannot be read. */
  read(path: string): Promise<string | null>;
  /** Whole-file write, creating parent folders; false on failure. */
  write(path: string, text: string): Promise<boolean>;
  /** Delete one file; a missing file counts as success. */
  remove(path: string): Promise<boolean>;
}

export async function writeContract(
  root: string,
  values: Record<string, unknown>,
  figures: Record<string, string>,
  io: PathIO,
): Promise<void> {
  const names = Object.keys(figures).sort();
  const collisions = new Set<string>();
  for (const name of names) {
    const key = name.toLocaleLowerCase('en-US');
    if (!isSafeFigureName(name) || collisions.has(key)) {
      throw new Error(`unsafe or colliding figure artifact name: ${JSON.stringify(name)}`);
    }
    collisions.add(key);
  }
  const manifestPath = `${root}/${ARTIFACT_MANIFEST}`;
  const previousText = await io.read(manifestPath);
  // Without a trustworthy record, Knuth owns nothing and deletes nothing.
  const previous = previousText === null ? new Set<string>() : parseOwnedFigureNames(previousText);

  if (!(await io.write(`${root}/values.json`, JSON.stringify(values, null, 2) + '\n'))) {
    throw new Error('could not write values.json');
  }
  for (const name of names) {
    if (!(await io.write(`${root}/figs/${name}.svg`, figures[name]))) {
      throw new Error(`could not write figs/${name}.svg`);
    }
  }
  const current = new Set(names);
  for (const name of previous) {
    if (!current.has(name)) await io.remove(`${root}/figs/${name}.svg`);
  }
  // Ownership last: it never claims a file that was not already written.
  if (!(await io.write(manifestPath, manifestText(names)))) {
    throw new Error('could not write the artifact manifest');
  }
}
