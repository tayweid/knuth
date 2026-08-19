import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  parseDocument,
  serializeDocument,
  cellCode,
  textProse,
  setProse,
  outputText,
  setOutput,
} from './percent.ts';

const corpusDir = fileURLToPath(new URL('./corpus/', import.meta.url));
const corpus = new Map(
  readdirSync(corpusDir)
    .filter((f) => f.endsWith('.py'))
    .map((f) => [f, readFileSync(corpusDir + f, 'utf8')] as const),
);

// Every corpus file must survive parse -> serialize byte-identically.
for (const [name, text] of corpus) {
  assert.equal(serializeDocument(parseDocument(text)), text, `round-trip: ${name}`);
}

// Every corpus file's parsed structure matches corpus-structure.json — the
// same expectations python/tests/test_run.py asserts against percent.py, so
// the two parsers must agree on structure, not just on round-tripping (the
// CRLF divergence hid in exactly that gap).
{
  const expected = JSON.parse(
    readFileSync(fileURLToPath(new URL('./corpus-structure.json', import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(expected).sort(), [...corpus.keys()].sort());
  for (const [name, text] of corpus) {
    const doc = parseDocument(text);
    const signature = {
      preamble: doc.preamble.length,
      trailingNewline: doc.trailingNewline,
      cells: doc.cells.map((c) => ({
        kind: c.kind,
        marker: c.marker,
        source: c.source.length,
        output: c.output.length,
        trailing: c.trailing.length,
      })),
    };
    assert.deepEqual(signature, expected[name], `structure: ${name}`);
  }
}

// Degenerate inputs round-trip too.
for (const text of ['', '\n', 'x = 1', '# %%']) {
  assert.equal(serializeDocument(parseDocument(text)), text, `round-trip: ${JSON.stringify(text)}`);
}

// Structure: basic.py
{
  const doc = parseDocument(corpus.get('basic.py')!);
  assert.equal(doc.preamble.length, 0);
  assert.deepEqual(doc.cells.map((c) => c.kind), ['text', 'program', 'program']);
  assert.equal(textProse(doc.cells[0]), '# Basic document\n\nProse with **markdown**.\n');
  assert.equal(cellCode(doc.cells[2]), 'print(x)');
}

// Structure: jupytext.py — header stays preamble; titles/tags/bare-#%% are program cells.
{
  const doc = parseDocument(corpus.get('jupytext.py')!);
  assert.equal(doc.preamble[0], '# ---');
  assert.deepEqual(doc.cells.map((c) => c.kind), ['text', 'program', 'program', 'program']);
  assert.equal(doc.cells[1].marker, '#%%');
  assert.equal(doc.cells[2].marker, '# %% This cell has a title');
}

// Structure: outputs.py — kinds, output blocks, stripped content.
{
  const doc = parseDocument(corpus.get('outputs.py')!);
  assert.deepEqual(doc.cells.map((c) => c.kind), ['program', 'scratch', 'program']);
  assert.deepEqual(doc.cells.map((c) => c.output.length), [1, 1, 1]);
  assert.deepEqual(doc.cells.map(outputText), ['42', '84', 'figs/fig.svg']);
  assert.equal(cellCode(doc.cells[0]), 'x = 42\nprint(x)');
}

// Structure: script.py — no markers means everything is preamble.
{
  const doc = parseDocument(corpus.get('script.py')!);
  assert.equal(doc.cells.length, 0);
  assert.equal(doc.preamble.length, 4);
}

// Structure: edge.py — empty cell, no trailing newline.
{
  const doc = parseDocument(corpus.get('edge.py')!);
  assert.equal(doc.trailingNewline, false);
  assert.equal(doc.cells.length, 2);
  assert.equal(cellCode(doc.cells[1]), 'x = 1');
}

// Structure: crlf.py — CRLF endings still delimit cells; \r stays in the bytes.
{
  const doc = parseDocument(corpus.get('crlf.py')!);
  assert.equal(doc.preamble.length, 2);
  assert.deepEqual(doc.cells.map((c) => c.kind), ['program', 'text', 'scratch']);
  assert.equal(doc.cells[0].output.length, 1);
}

// setOutput: replace, multi-line, blank-line canonicalization, stability.
{
  const doc = parseDocument(corpus.get('outputs.py')!);
  setOutput(doc.cells[0], '43\n\nextra');
  assert.deepEqual(doc.cells[0].output, ['#-> 43', '#->', '#-> extra']);
  const once = serializeDocument(doc);
  assert.ok(once.includes('print(x)\n#-> 43\n#->\n#-> extra\n\n# %% scratch'));
  assert.equal(serializeDocument(parseDocument(once)), once, 'mutated doc still round-trips');
  assert.equal(outputText(parseDocument(once).cells[0]), '43\n\nextra');
}

// setOutput on a cell with no output: separator blank lines migrate, spacing intact.
{
  const doc = parseDocument(corpus.get('basic.py')!);
  setOutput(doc.cells[2], 'done');
  assert.equal(serializeDocument(doc).endsWith('print(x)\n#-> done\n'), true);
  setOutput(doc.cells[1], '<pandas loaded>');
  assert.ok(serializeDocument(doc).includes('x = 42\n#-> <pandas loaded>\n\n# %%\nprint(x)'));
}

// setOutput(null): clears the block, keeps the blank separator line.
{
  const doc = parseDocument(corpus.get('outputs.py')!);
  setOutput(doc.cells[0], null);
  const text = serializeDocument(doc);
  assert.ok(text.startsWith('# %%\nx = 42\nprint(x)\n\n# %% scratch'));
  assert.equal(serializeDocument(parseDocument(text)), text);
}

// setProse: canonical "# " prefixing round-trips through parse.
{
  const doc = parseDocument(corpus.get('basic.py')!);
  setProse(doc.cells[0], 'New title\n\nBody.');
  assert.deepEqual(doc.cells[0].source, ['# New title', '#', '# Body.']);
  const text = serializeDocument(doc);
  assert.equal(textProse(parseDocument(text).cells[0]), 'New title\n\nBody.');
}

console.log(`round-trip.test: all assertions passed (${corpus.size} corpus files)`);
