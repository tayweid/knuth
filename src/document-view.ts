// The cell document: CodeMirror program/scratch cells and always-editable
// markdown text cells over the format layer, wired to the kernel. Linear
// execution model (DESIGN.md): editing a program cell marks it and
// everything below stale; "run stale" replays in document order. Outputs
// stream in live and are written back into the document as "#->" blocks.
//
// Shortcuts (Jupyter-standard): Cmd-Enter run in place, Shift-Enter run
// and advance (creating a cell at the end), Alt-Enter run and insert
// below. New cells also come from hover insert strips between cells.

import { minimalSetup, EditorView } from 'codemirror';
import { keymap, placeholder } from '@codemirror/view';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  type Cell,
  type KnuthDocument,
  parseDocument,
  cellCode,
  textProse,
  setProse,
  setOutput,
  outputText,
} from './format/percent.ts';
import type { Kernel } from './kernel/kernel.ts';

// Stored-output cap (the DESIGN.md truncation policy).
const MAX_OUTPUT_LINES = 40;

function truncate(text: string): string {
  // Memory addresses in reprs change every run; receipts must not churn.
  text = text.replace(/0x[0-9a-fA-F]{6,}/g, '0x…');
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines.length <= MAX_OUTPUT_LINES) return lines.join('\n');
  const kept = lines.slice(0, MAX_OUTPUT_LINES);
  kept.push(`… (+${lines.length - MAX_OUTPUT_LINES} more lines)`);
  return kept.join('\n');
}

interface CellView {
  cell: Cell;
  /** Wrapper: insert strip + the cell row. */
  root: HTMLElement;
  row: HTMLElement;
  body: HTMLElement;
  outEl: HTMLPreElement;
  badge: HTMLElement;
  editor?: EditorView;
  stale: boolean;
  running: boolean;
}

export class DocumentView {
  doc: KnuthDocument = parseDocument('# %%\n');
  private views: CellView[] = [];
  private endZone!: HTMLElement;

  constructor(
    private container: HTMLElement,
    private kernel: Kernel,
    private onChange: () => void,
    /** A program cell finished cleanly — namespace/artifacts moved. */
    private onProgramRun?: () => void,
    /** Any code cell finished (ok or not) — the session may have changed. */
    private onRun?: () => void,
    /** A cell was deleted; calling `restore` puts it back. */
    private onCellDeleted?: (restore: () => void) => void,
  ) {}

  setDoc(doc: KnuthDocument) {
    for (const v of this.views) v.editor?.destroy();
    this.views = [];
    this.container.textContent = '';
    this.doc = doc;
    this.endZone = this.buildZone(null);
    this.container.append(this.endZone);
    for (const cell of doc.cells) {
      const view = this.buildView(cell);
      this.views.push(view);
      this.endZone.before(view.root);
    }
    // A fresh page means a fresh session: nothing has run yet.
    this.markAllStale();
  }

  markAllStale() {
    for (const v of this.views) {
      if (v.cell.kind === 'program') v.stale = true;
      this.refreshBadge(v);
    }
  }

  async runAllProgram() {
    for (const v of [...this.views]) {
      if (v.cell.kind !== 'program') continue;
      const outcome = await this.runCell(v);
      if (!outcome) break; // error or interrupt: stop the replay
    }
  }

  async runStale() {
    for (const v of [...this.views]) {
      if (v.cell.kind !== 'program' || !v.stale) continue;
      const outcome = await this.runCell(v);
      if (!outcome) break;
    }
  }

  /** Run one code cell; resolves true when it finished cleanly. */
  private async runCell(v: CellView): Promise<boolean> {
    if (v.cell.kind === 'text' || v.running) return false;
    v.running = true;
    this.refreshBadge(v);
    v.outEl.textContent = '';
    v.outEl.hidden = false;
    let text = '';
    const outcome = await this.kernel.run(
      cellCode(v.cell),
      {
        onStream: (_which, chunk) => {
          text += chunk;
          v.outEl.textContent = truncate(text);
        },
      },
      { scratch: v.cell.kind === 'scratch' },
    );
    if (outcome.ok && outcome.result !== null) {
      text += (text === '' || text.endsWith('\n') ? '' : '\n') + outcome.result;
    }
    if (!outcome.ok && outcome.traceback) {
      text += (text === '' || text.endsWith('\n') ? '' : '\n') + outcome.traceback;
    }
    const stored = truncate(text);
    setOutput(v.cell, stored === '' ? null : stored);
    v.outEl.textContent = stored;
    v.outEl.hidden = stored === '';
    v.outEl.classList.toggle('error', !outcome.ok);
    v.running = false;
    if (outcome.ok && v.cell.kind === 'program') v.stale = false;
    this.refreshBadge(v);
    this.onChange();
    if (outcome.ok && v.cell.kind === 'program') this.onProgramRun?.();
    this.onRun?.();
    return outcome.ok;
  }

  private runAndAdvance(v: CellView) {
    void this.runCell(v);
    this.focusAfter(v, true);
  }

  private runAndInsertBelow(v: CellView) {
    void this.runCell(v);
    this.insertAfter(v, 'program');
  }

  /** Focus the next cell; optionally create one when v is last. */
  private focusAfter(v: CellView, createAtEnd: boolean) {
    const next = this.views[this.views.indexOf(v) + 1];
    if (next) next.editor?.focus();
    else if (createAtEnd) this.insertAfter(v, 'program');
  }

  // ---------- construction ----------

  private buildView(cell: Cell): CellView {
    const root = document.createElement('div');
    root.className = 'cell-wrap';

    const row = document.createElement('div');
    row.className = `cell kind-${cell.kind}`;

    const gutter = document.createElement('div');
    gutter.className = 'gutter';
    const badge = document.createElement('span');
    badge.className = 'badge';
    const body = document.createElement('div');
    body.className = 'body';
    const outEl = document.createElement('pre');
    outEl.className = 'output';

    const v: CellView = { cell, root, row, body, outEl, badge, stale: false, running: false };

    if (cell.kind === 'text') {
      gutter.append(badge);
      this.buildTextBody(v);
    } else {
      const run = document.createElement('button');
      run.className = 'run';
      run.textContent = '▶';
      run.title = 'Run cell (Cmd-Enter)';
      run.addEventListener('click', () => void this.runCell(v));
      gutter.append(run, badge);
      this.buildCodeBody(v);
    }

    const existing = outputText(cell);
    outEl.textContent = existing;
    outEl.hidden = existing === '';
    body.append(outEl);

    row.append(gutter, body, this.buildTools(v));
    root.append(this.buildZone(v), row);
    return v;
  }

  private cellKeymap(v: CellView) {
    return keymap.of([
      { key: 'Mod-Enter', run: () => (void this.runCell(v), true) },
      { key: 'Shift-Enter', run: () => (this.runAndAdvance(v), true) },
      { key: 'Alt-Enter', run: () => (this.runAndInsertBelow(v), true) },
      { key: 'Backspace', run: () => this.backspaceOnEmpty(v) },
    ]);
  }

  /** Backspace in an empty cell deletes it (Jupyter's affordance) and
   *  moves focus up; the deletion is restorable via onCellDeleted. */
  private backspaceOnEmpty(v: CellView): boolean {
    if (v.editor && v.editor.state.doc.length === 0 && this.views.length > 1) {
      const prev = this.views[this.views.indexOf(v) - 1] ?? this.views[1];
      this.remove(v);
      prev?.editor?.focus();
      return true;
    }
    return false;
  }

  private buildCodeBody(v: CellView) {
    v.editor = new EditorView({
      doc: cellCode(v.cell),
      extensions: [
        this.cellKeymap(v),
        minimalSetup,
        oneDark,
        python(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          v.cell.source = update.state.doc.toString().split('\n');
          this.markStaleFrom(v);
          this.onChange();
        }),
      ],
    });
    v.body.append(v.editor.dom);
    if (v.cell.kind === 'scratch') {
      const label = document.createElement('div');
      label.className = 'scratch-label';
      label.textContent = 'scratch';
      v.body.prepend(label);
    }
  }

  private buildTextBody(v: CellView) {
    // Text is just text: an always-live markdown editor styled as prose —
    // click anywhere, type, move with the cursor. No modes.
    v.editor = new EditorView({
      doc: textProse(v.cell).replace(/\n$/, ''),
      extensions: [
        keymap.of([
          { key: 'Shift-Enter', run: () => (this.focusAfter(v, false), true) },
          { key: 'Backspace', run: () => this.backspaceOnEmpty(v) },
        ]),
        minimalSetup,
        oneDark,
        markdown(),
        EditorView.lineWrapping,
        placeholder('Write…'),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          setProse(v.cell, update.state.doc.toString());
          v.cell.source.push(''); // keep the blank separator line in the raw file
          this.onChange();
        }),
      ],
    });
    v.body.append(v.editor.dom);
  }

  private buildTools(v: CellView): HTMLElement {
    const tools = document.createElement('div');
    tools.className = 'tools';
    const add = (label: string, title: string, action: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', action);
      tools.append(b);
    };
    // Program <-> scratch toggle, only when the marker carries no
    // title/attributes we would clobber.
    if (v.cell.marker === '# %%' || v.cell.marker === '# %% scratch') {
      add('⇄', 'Toggle program/scratch', () => {
        const toScratch = v.cell.kind === 'program';
        v.cell.kind = toScratch ? 'scratch' : 'program';
        v.cell.marker = toScratch ? '# %% scratch' : '# %%';
        this.rebuild(v);
        this.onChange();
      });
    }
    return tools;
  }

  /** Hover strip that inserts a cell before `v` (or at the end for null). */
  private buildZone(v: CellView | null): HTMLElement {
    const zone = document.createElement('div');
    zone.className = 'insert-zone';
    const inner = document.createElement('div');
    inner.className = 'insert-actions';
    const add = (label: string, kind: 'program' | 'text') => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => {
        if (v) this.insertBefore(v, kind);
        else this.insertAtEnd(kind);
      });
      inner.append(b);
    };
    add('+ Code', 'program');
    add('+ Text', 'text');
    zone.append(inner);
    return zone;
  }

  // ---------- structure edits ----------

  private newCell(kind: 'program' | 'text'): Cell {
    return kind === 'text'
      ? { kind, marker: '# %% [markdown]', source: [''], output: [], trailing: [] }
      : { kind, marker: '# %%', source: [''], output: [], trailing: [] };
  }

  /** Keep a blank separator line at the end of the cell above the gap. */
  private ensureSeparator(prev: CellView | undefined) {
    if (!prev) return;
    const seg = prev.cell.output.length ? prev.cell.trailing : prev.cell.source;
    if (seg[seg.length - 1]?.trim() !== '') seg.push('');
  }

  private insertAt(i: number, kind: 'program' | 'text') {
    const cell = this.newCell(kind);
    this.ensureSeparator(this.views[i - 1]);
    this.doc.cells.splice(i, 0, cell);
    const view = this.buildView(cell);
    this.views.splice(i, 0, view);
    if (i + 1 < this.views.length) this.views[i + 1].root.before(view.root);
    else this.endZone.before(view.root);
    if (kind === 'program') {
      view.stale = true;
      this.refreshBadge(view);
    }
    view.editor?.focus();
    this.onChange();
  }

  private insertAfter(v: CellView, kind: 'program' | 'text') {
    this.insertAt(this.views.indexOf(v) + 1, kind);
  }

  private insertBefore(v: CellView, kind: 'program' | 'text') {
    this.insertAt(this.views.indexOf(v), kind);
  }

  private insertAtEnd(kind: 'program' | 'text') {
    this.insertAt(this.views.length, kind);
  }

  private remove(v: CellView) {
    const i = this.views.indexOf(v);
    const cell = v.cell;
    this.doc.cells.splice(i, 1);
    this.views.splice(i, 1);
    v.editor?.destroy();
    v.root.remove();
    this.markStaleFromIndex(i);
    this.onChange();
    if (this.views.length === 0) this.insertAtEnd('program');
    this.onCellDeleted?.(() => {
      const at = Math.min(i, this.views.length);
      this.doc.cells.splice(at, 0, cell);
      const view = this.buildView(cell);
      this.views.splice(at, 0, view);
      if (at + 1 < this.views.length) this.views[at + 1].root.before(view.root);
      else this.endZone.before(view.root);
      if (cell.kind === 'program') {
        view.stale = true;
        this.refreshBadge(view);
      }
      view.editor?.focus();
      this.onChange();
    });
  }

  private rebuild(v: CellView) {
    const fresh = this.buildView(v.cell);
    fresh.stale = v.cell.kind === 'program';
    v.editor?.destroy();
    v.root.replaceWith(fresh.root);
    this.views[this.views.indexOf(v)] = fresh;
    this.refreshBadge(fresh);
  }

  // ---------- staleness ----------

  private markStaleFrom(v: CellView) {
    if (v.cell.kind !== 'program') return; // scratch/text edits stale nothing
    this.markStaleFromIndex(this.views.indexOf(v));
  }

  private markStaleFromIndex(i: number) {
    for (const view of this.views.slice(Math.max(i, 0))) {
      if (view.cell.kind === 'program' && !view.stale) {
        view.stale = true;
        this.refreshBadge(view);
      }
    }
  }

  get staleCount(): number {
    return this.views.filter((v) => v.stale).length;
  }

  private refreshBadge(v: CellView) {
    v.badge.textContent = v.running ? '●' : v.stale ? '○' : '';
    v.badge.title = v.running ? 'running' : v.stale ? 'stale — not run in this session' : '';
    v.row.classList.toggle('stale', v.stale);
    v.row.classList.toggle('running', v.running);
  }
}
