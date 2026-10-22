// Export to Markdown (export.ts): the document as Plass reads it, code
// hidden. Run: node --import tsx src/export.test.ts
import assert from 'node:assert/strict';
import { exportName, pipeTable, shownName, svgDataUrl, toMarkdown, type ExportCell } from './export.ts';

// The name a cell ends by showing: a bare name on the last code line.
assert.equal(shownName('prices = load()\nprices'), 'prices');
assert.equal(shownName('prices\n# a comment\n'), 'prices');
assert.equal(shownName('prices.head()'), null);
assert.equal(shownName('x = prices'), null);
assert.equal(shownName('pass'), null);
assert.equal(shownName(''), null);

// SVG as a data URL, UTF-8 safe.
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>π ≈ 3.14</text></svg>';
const url = svgDataUrl(svg);
assert.ok(url.startsWith('data:image/svg+xml;base64,'));
assert.equal(new TextDecoder().decode(Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0))), svg);

// A pipe table: the index first, numbers right-aligned, pipes escaped,
// and a line saying how many rows there were.
assert.equal(
  pipeTable({ columns: ['price', 'note'], index: ['0', '1'], rows: [['0.5', 'a|b'], ['1.0', 'c']], total: 250 }),
  [
    '|  | price | note |',
    '| :-- | --: | :-- |',
    '| 0 | 0.5 | a\\|b |',
    '| 1 | 1.0 | c |',
    '',
    '*The first 2 of 250 rows.*',
  ].join('\n'),
);

// The document: the opening heading is the title; text as written; a
// code cell is its table and figures, and nothing of its code.
const cells: ExportCell[] = [
  { kind: 'text', prose: '# Growth\n\nThe yearly rate, from $g_t$.' },
  { kind: 'program', code: 'gdp = [1, 2]\nrate = 0.062\nrate', figures: [] },
  { kind: 'text', prose: '## Method\n\nThe figure:' },
  { kind: 'program', code: 'ax.plot(gdp)', figures: [svg] },
  { kind: 'program', code: 'df', figures: [], table: { columns: ['q'], index: ['0'], rows: [['3']], total: 1 } },
];
const md = toMarkdown(cells);
assert.ok(md.startsWith('---\ntitle: "Growth"\n---\n\nThe yearly rate, from $g_t$.\n\n## Method\n\nThe figure:\n\n![](data:image/svg+xml;base64,'));
assert.ok(!md.includes('gdp = '));
assert.ok(!md.includes('ax.plot'));
assert.ok(md.includes('|  | q |\n| :-- | --: |\n| 0 | 3 |'));
assert.ok(md.endsWith('|\n'));
// No opening heading: no front matter.
assert.equal(toMarkdown([{ kind: 'text', prose: 'Just text.' }]), 'Just text.\n');
// A title in quotes survives as YAML.
assert.ok(toMarkdown([{ kind: 'text', prose: '# The "best" fit' }]).startsWith('---\ntitle: "The \\"best\\" fit"\n---'));

// The file's name.
assert.equal(exportName('growth.py'), 'growth.md');
assert.equal(exportName('notes.v2.py'), 'notes.v2.md');
assert.equal(exportName(''), 'Untitled.md');

console.log('export: ok');
