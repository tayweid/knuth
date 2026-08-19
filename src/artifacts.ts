// Safe names and ownership metadata for generated project artifacts — the
// TypeScript twin of python/knuth/artifacts.py, used when the app (rather
// than knuth run) materializes the folder contract. The two must agree:
// artifacts.test.ts mirrors test_artifacts.py's cases so a divergence — a
// Windows-reserved name accepted, a manifest read differently — fails a
// test instead of deleting the wrong file.

export const ARTIFACT_MANIFEST = '.knuth-artifacts.json';
export const MANIFEST_VERSION = 1;
export const MAX_FIGURE_NAME_BYTES = 128;
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

/** Whether a Python binding is one portable SVG filename component. */
export function isSafeFigureName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith('_') &&
    /^\p{ID_Start}\p{ID_Continue}*$/u.test(name) &&
    name === name.normalize('NFC') &&
    new TextEncoder().encode(name).byteLength <= MAX_FIGURE_NAME_BYTES &&
    !WINDOWS_RESERVED_NAMES.has(name.toUpperCase())
  );
}

export function figurePath(name: string): string {
  if (!isSafeFigureName(name)) {
    throw new Error(`unsafe figure artifact name: ${JSON.stringify(name)}`);
  }
  return `figs/${name}.svg`;
}

export function manifestText(names: string[]): string {
  return (
    JSON.stringify({ version: MANIFEST_VERSION, figures: names.map(figurePath) }, null, 2) + '\n'
  );
}

/** Parse only safe current-format paths; malformed manifests own nothing. */
export function parseOwnedFigureNames(raw: string): Set<string> {
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== 'object') return new Set();
    const manifest = data as { version?: unknown; figures?: unknown };
    if (manifest.version !== MANIFEST_VERSION || !Array.isArray(manifest.figures)) {
      return new Set();
    }
    const names = new Set<string>();
    for (const path of manifest.figures) {
      if (typeof path !== 'string' || !path.startsWith('figs/') || !path.endsWith('.svg')) {
        return new Set();
      }
      const name = path.slice('figs/'.length, -'.svg'.length);
      if (!isSafeFigureName(name) || path !== `figs/${name}.svg`) return new Set();
      names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}
