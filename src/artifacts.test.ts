// Mirrors python/tests/test_artifacts.py's name-safety and manifest cases:
// the same inputs must get the same verdicts in both languages, because
// each side independently decides which figs/*.svg files Knuth owns and
// may delete.
import assert from 'node:assert/strict';
import { isSafeFigureName, manifestText, parseOwnedFigureNames } from './artifacts.ts';

// test_portable_figure_names
for (const name of ['fig', 'plot_2', 'café', 'Διάγραμμα']) {
  assert.equal(isSafeFigureName(name), true, `portable: ${name}`);
}

// test_unsafe_figure_names_are_rejected
for (const name of ['', '_private', '../escape', 'a/b', '.', 'CON', 'Lpt9', 'é', 'x'.repeat(129)]) {
  assert.equal(isSafeFigureName(name), false, `unsafe: ${JSON.stringify(name)}`);
}

// test_manifest_parser_fails_closed
assert.deepEqual(
  parseOwnedFigureNames(manifestText(['fig', 'café'])),
  new Set(['fig', 'café']),
);
assert.deepEqual(
  parseOwnedFigureNames('{"version": 1, "figures": ["figs/../owned.svg"]}'),
  new Set(),
);
assert.deepEqual(
  parseOwnedFigureNames(JSON.stringify({ version: 999, figures: ['figs/fig.svg'] })),
  new Set(),
);
assert.deepEqual(parseOwnedFigureNames('not json'), new Set());
assert.deepEqual(parseOwnedFigureNames('{"version": 1, "figures": "figs/fig.svg"}'), new Set());

console.log('artifacts.test: all assertions passed');
