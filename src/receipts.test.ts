// The receipt's rules (receipts.ts, docs/SESSION.md): marks against the
// session before the run, what the snapshot after it adds, the chip, the
// order of the names.
import assert from 'node:assert/strict';
import type { NamespaceVar } from './kernel/kernel.ts';
import {
  briefValue,
  chipCount,
  chipKind,
  folderLine,
  inCellOrder,
  kindGlyph,
  overlay,
  receiptFromRun,
  settle,
  took,
  typeLabel,
  type RunFacts,
} from './receipts.ts';

const v = (name: string, type: string, preview: string, more: Partial<NamespaceVar> = {}): NamespaceVar =>
  ({ name, type, preview, ...more });
const run = (id: string, bound: NamespaceVar[] | undefined, more: Partial<RunFacts> = {}): RunFacts =>
  ({ id, ms: 380, ok: true, scratch: false, bound, figures: [], named: [], batch: false, ...more });

// A first run: everything it bound is new.
const empty = new Map<string, NamespaceVar>();
const prices = v('prices', 'DataFrame', '<df>', { shape: [1200, 2] });
const n = v('n', 'int', '1200', { saved: true });
let r1 = receiptFromRun(run('c1', [prices, n]), empty);
assert.deepEqual(r1.rows.map((row) => `${row.mark}${row.name}`), ['+prices', '+n']);
assert.deepEqual(r1.unchanged, []);
assert.equal(chipKind(r1), 'table');
assert.equal(chipCount(r1), 2);
assert.deepEqual(folderLine(r1), { values: ['n'], figs: [] });

// The snapshot after it adds nothing, keeps `saved`, and takes the fresher entry.
settle(r1, empty, [{ ...prices, preview: '<df 2>' }, v('n', 'int', '1200')]);
assert.equal(r1.settled, true);
assert.equal(r1.rows[0].v.preview, '<df 2>');
assert.equal(r1.rows[1].v.saved, true);

// A second run rebinds one name, changes another in place, and binds one
// inside an `if` the AST cannot see: ~, ~ (in place), +.
let before = new Map([['prices', prices], ['n', n]]);
const demand = v('demand', 'Series', 's', { length: 3 });
const r2 = receiptFromRun(run('c3', [v('n', 'int', '1201')]), before);
assert.deepEqual(r2.rows.map((row) => `${row.mark}${row.name}`), ['~n']);
assert.deepEqual(r2.unchanged, ['prices']);
settle(r2, before, [{ ...prices, shape: [1200, 3] }, v('n', 'int', '1201'), demand]);
assert.deepEqual(r2.rows.map((row) => `${row.mark}${row.name}${row.inPlace ? '*' : ''}`), ['~n', '~prices*', '+demand']);
assert.deepEqual(r2.unchanged, []);

// An older engine (no bound) or a failed run: the receipt comes from the
// snapshot alone; an unchanged session gives an empty receipt and no chip.
before = new Map([['n', n]]);
const r3 = receiptFromRun(run('c4', undefined, { ok: false }), before);
assert.deepEqual(r3.rows, []);
settle(r3, before, [n]);
assert.deepEqual(r3.rows, []);
assert.deepEqual(r3.unchanged, ['n']);
assert.equal(chipKind(r3), null);

// In a batch the next run is marked against the session plus what the
// last one bound, before the snapshot has landed.
const after1 = overlay(empty, receiptFromRun(run('c1', [prices]), empty));
assert.equal(receiptFromRun(run('c2', [v('prices', 'DataFrame', '<df>')]), after1).rows[0].mark, '~');

// A figure: the chip says so, the folder gets figs/<name>.svg.
const r4 = receiptFromRun(run('c5', [v('ax', 'Axes', '<Axes>', { figure: true })], { figures: ['<svg/>'], named: ['ax'] }), empty);
assert.equal(chipKind(r4), 'figure');
assert.deepEqual(folderLine(r4), { values: [], figs: ['figs/ax.svg'] });
// A figure no name holds still counts.
assert.equal(chipCount(receiptFromRun(run('c6', [], { figures: ['<svg/>'] }), empty)), 1);

// Names in cell order: by the owning cell's place, then the cell's own
// order; names with no owner last, in namespace order.
const receipts = new Map([['c1', r1], ['c3', r2]]);
const owner = new Map([['prices', 'c3'], ['n', 'c3'], ['demand', 'c3'], ['old', 'gone']]);
owner.set('prices', 'c1');
assert.deepEqual(
  inCellOrder(['old', 'demand', 'n', 'prices', 'stray'], owner, ['c1', 'c3'], receipts),
  ['prices', 'n', 'demand', 'old', 'stray'],
);

// Kinds and words.
assert.equal(kindGlyph(v('df', 'DataFrame', '')), 'table');
assert.equal(kindGlyph(v('a', 'ndarray', '', { shape: [3] })), 'series');
assert.equal(kindGlyph(v('m', 'ndarray', '', { shape: [3, 3] })), 'table');
assert.equal(kindGlyph(v('x', 'float64', '1.0')), 'value');
assert.equal(kindGlyph(v('f', 'function', '')), 'fn');
assert.equal(kindGlyph(v('l', 'list', '[]', { length: 0 })), 'list');
assert.equal(kindGlyph(v('m', 'RegressionResultsWrapper', '')), 'object');
assert.equal(typeLabel(v('df', 'DataFrame', '', { shape: [1200, 2] })), 'DataFrame 1200×2');
assert.equal(typeLabel(v('n', 'int', '3')), 'int');
assert.equal(took(12.4), '12 ms');
assert.equal(took(380), '0.38 s');
assert.equal(took(12_345), '12.3 s');

// A float where a narrow row shows it: six significant digits, no trailing
// zeros; a short one, an int, a string or a float's oddities as they are.
assert.equal(briefValue(v('elasticity', 'float64', '-0.4088817904210866')), '-0.408882');
assert.equal(briefValue(v('total', 'float', '3.25')), '3.25');
assert.equal(briefValue(v('tiny', 'float', '1.234567891e-07')), '1.23457e-7');
assert.equal(briefValue(v('big', 'float32', '123456789.0')), '1.23457e+8');
assert.equal(briefValue(v('third', 'float', '0.3333333333333333')), '0.333333');
assert.equal(briefValue(v('nan', 'float64', 'nan')), 'nan');
assert.equal(briefValue(v('n', 'int', '12345678901234567890')), '12345678901234567890');
assert.equal(briefValue(v('label', 'str', "'0.4088817904210866'")), "'0.4088817904210866'");

console.log('receipts: ok');
