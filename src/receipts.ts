// The receipt (docs/SESSION.md): what one run of a cell did — the names it
// bound (new or rebound), the figures it drew, what it put in the folder —
// as one data structure under the session's three surfaces (session.ts):
// the card beside the cell that flies up into the pill, the chip that stays
// at the cell's corner, and the Session card's top. Pure: no DOM, so the
// rules are tested in node (receipts.test.ts).

import type { NamespaceVar } from './kernel/kernel.ts';
import { isTabular, shapeLabel } from './viewers.ts';

/** + first bound by this run; ~ rebound (or, in place, changed) by it. */
export type Mark = '+' | '~';

export interface ReceiptRow {
  name: string;
  mark: Mark;
  v: NamespaceVar;
  /** Changed without being assigned (`prices['q'] = …`): the AST saw no
   *  binding, the snapshot after the run did. */
  inPlace?: boolean;
}

export interface Receipt {
  /** The cell (DocumentView's CellView.id). */
  id: string;
  ms: number;
  ok: boolean;
  scratch: boolean;
  batch: boolean;
  rows: ReceiptRow[];
  /** The session's other names when the run ended: what it left alone. */
  unchanged: string[];
  /** The figures it drew, as SVG (shown as a thumbnail, never live). */
  figures: string[];
  /** figs/<name>.svg it touched (the run's figure receipts). */
  named: string[];
  /** From before a restart: the chip fades, the names are gone. */
  past: boolean;
  /** The snapshot after the run has been read into it. */
  settled: boolean;
}

/** What a finished run hands the session (document-view.ts's RunInfo). */
export interface RunFacts {
  id: string;
  ms: number;
  ok: boolean;
  scratch: boolean;
  bound?: NamespaceVar[];
  figures: string[];
  named: string[];
  batch: boolean;
}

/** One value's identity for "did it change": kind, size and preview. */
export function summary(v: NamespaceVar): string {
  return [v.type, v.shape?.join('×') ?? '', v.length ?? '', v.preview, v.scratch ? 's' : ''].join('|');
}

/** The receipt as the run's done event gives it: its bound names, marked
 *  against the session as the page last knew it (`before`). */
export function receiptFromRun(run: RunFacts, before: Map<string, NamespaceVar>): Receipt {
  const rows: ReceiptRow[] = (run.bound ?? []).map((v) => ({
    name: v.name,
    mark: before.has(v.name) ? '~' : '+',
    v,
  }));
  const taken = new Set(rows.map((row) => row.name));
  return {
    id: run.id,
    ms: run.ms,
    ok: run.ok,
    scratch: run.scratch,
    batch: run.batch,
    rows,
    unchanged: [...before.keys()].filter((name) => !taken.has(name)),
    figures: run.figures,
    named: run.named,
    past: false,
    settled: false,
  };
}

/** The session as it stood before the run, plus what the run bound: what
 *  the next run in a batch is marked against before the snapshot lands. */
export function overlay(before: Map<string, NamespaceVar>, receipt: Receipt): Map<string, NamespaceVar> {
  const next = new Map(before);
  for (const row of receipt.rows) next.set(row.name, row.v);
  return next;
}

/** Read the snapshot taken after the run into its receipt: names the AST
 *  could not see (bound in an `if`, changed in place, a star import) join
 *  it, every row takes the fresher entry, and `unchanged` becomes what is
 *  really left. A failed run's receipt is built only here. */
export function settle(receipt: Receipt, before: Map<string, NamespaceVar>, after: NamespaceVar[]): void {
  const rows = new Map(receipt.rows.map((row) => [row.name, row]));
  const present = new Set(after.map((v) => v.name));
  for (const v of after) {
    const row = rows.get(v.name);
    if (row) {
      // The snapshot does not say what values.json mirrors; the run did.
      row.v = row.v.saved ? { ...v, saved: true } : v;
      continue;
    }
    const prev = before.get(v.name);
    if (!prev) receipt.rows.push({ name: v.name, mark: '+', v });
    else if (summary(prev) !== summary(v)) receipt.rows.push({ name: v.name, mark: '~', v, inPlace: true });
  }
  // A name the run bound and then deleted is not in the session.
  receipt.rows = receipt.rows.filter((row) => present.has(row.name));
  const taken = new Set(receipt.rows.map((row) => row.name));
  receipt.unchanged = after.map((v) => v.name).filter((name) => !taken.has(name));
  receipt.settled = true;
}

/** What the chip says the run produced: a figure, a table, or names; null
 *  when it bound and drew nothing (no chip). */
export function chipKind(receipt: Receipt): 'figure' | 'table' | 'names' | null {
  if (receipt.figures.length || receipt.named.length || receipt.rows.some((row) => row.v.figure)) return 'figure';
  if (receipt.rows.some((row) => isTabular(row.v))) return 'table';
  return receipt.rows.length ? 'names' : null;
}

/** The chip's count: the names the run bound, or (a figure alone) the
 *  figures it drew. */
export function chipCount(receipt: Receipt): number {
  return receipt.rows.length || receipt.figures.length || receipt.named.length;
}

/** The kind glyph beside a name (icons.ts). */
export function kindGlyph(v: NamespaceVar): string {
  if (v.figure) return 'figure';
  if (v.type === 'DataFrame' || (v.type === 'ndarray' && v.shape?.length === 2)) return 'table';
  if (v.type === 'Series' || v.type === 'ndarray') return 'series';
  if (['function', 'builtin_function_or_method', 'method', 'type', 'partial'].includes(v.type)) return 'fn';
  if (['list', 'tuple', 'dict', 'set', 'frozenset', 'range', 'deque'].includes(v.type)) return 'list';
  if (['int', 'float', 'str', 'bool', 'complex', 'NoneType', 'bytes', 'Decimal', 'Fraction'].includes(v.type) ||
    /^(u?int|float|complex|bool_)\d*$/.test(v.type)) return 'value';
  return 'object';
}

/** "Series 3", "DataFrame 1200×2", "int": a name's kind in words. */
export function typeLabel(v: NamespaceVar): string {
  const shape = shapeLabel(v);
  return v.type + (shape ? ` ${shape}` : '');
}

/** How long a run took, as the receipt's head shows it. */
export function took(ms: number): string {
  if (ms < 100) return `${Math.max(1, Math.round(ms))} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** The session's names in cell order: by the document position of the
 *  cell that owns each (unowned names — bound before this page loaded, or
 *  by a cell since deleted — last), then in the order the cell bound them,
 *  then in the namespace's own order. */
export function inCellOrder(
  names: string[],
  owner: Map<string, string>,
  cells: string[],
  receipts: Map<string, Receipt>,
): string[] {
  const position = new Map(cells.map((id, i) => [id, i]));
  const rank = (name: string): [number, number] => {
    const id = owner.get(name);
    const at = id === undefined ? undefined : position.get(id);
    if (id === undefined || at === undefined) return [Infinity, 0];
    const within = receipts.get(id)?.rows.findIndex((row) => row.name === name) ?? -1;
    return [at, within < 0 ? Infinity : within];
  };
  return names
    .map((name, i) => ({ name, i, r: rank(name) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.i - b.i)
    .map((entry) => entry.name);
}

/** What the run put in the folder: values.json keys and figs/ files. */
export function folderLine(receipt: Receipt): { values: string[]; figs: string[] } {
  return {
    values: receipt.rows.filter((row) => row.v.saved).map((row) => row.name),
    figs: receipt.named.map((name) => `figs/${name}.svg`),
  };
}
