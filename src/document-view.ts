// The cell document: CodeMirror program/scratch cells and markdown text
// cells over the format layer, wired to the kernel. Linear execution
// model (DESIGN.md): editing a program cell marks it and everything below
// stale; "run stale" replays in document order. Outputs stream in live
// and are written back into the document as "#->" blocks.

import { minimalSetup, EditorView } from 'codemirror';
import { keymap } from '@codemirror/view';
import { python } from '@codemirror/lang-python';
import MarkdownIt from 'markdown-it';
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

const md = new MarkdownIt({ html: false, linkify: true });

// Stored-output cap (the DESIGN.md truncation policy).
const MAX_OUTPUT_LINES = 40;

function truncate(text: string): string {
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines.length <= MAX_OUTPUT_LINES) return lines.join('\n');
  const kept = lines.slice(0, MAX_OUTPUT_LINES);
  kept.push(`… (+${lines.length - MAX_OUTPUT_LINES} more lines)`);
  return kept.join('\n');
}

interface CellView {
  cell: Cell;
  root: HTMLElement;
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

  constructor(
    private container: HTMLElement,
    private kernel: Kernel,
    private onChange: () => void,
    /** A program cell finished cleanly — namespace/artifacts moved. */
    private onProgramRun?: () => void,
  ) {}

  setDoc(doc: KnuthDocument) {
    for (const v of this.views) v.editor?.destroy();
    this.views = [];
    this.container.textContent = '';
    this.doc = doc;
    for (const cell of doc.cells) this.appendView(this.buildView(cell));
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
    const outcome = await this.kernel.run(cellCode(v.cell), {
      onStream: (_which, chunk) => {
        text += chunk;
        v.outEl.textContent = truncate(text);
      },
    });
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
    return outcome.ok;
  }

  // ---------- construction ----------

  private buildView(cell: Cell): CellView {
    const root = document.createElement('div');
    root.className = `cell kind-${cell.kind}`;

    const gutter = document.createElement('div');
    gutter.className = 'gutter';
    const badge = document.createElement('span');
    badge.className = 'badge';
    const body = document.createElement('div');
    body.className = 'body';
    const outEl = document.createElement('pre');
    outEl.className = 'output';

    const v: CellView = { cell, root, body, outEl, badge, stale: false, running: false };

    if (cell.kind === 'text') {
      gutter.append(badge);
      this.buildTextBody(v);
    } else {
      const run = document.createElement('button');
      run.className = 'run';
      run.textContent = '▶';
      run.title = 'Run cell (Shift-Enter)';
      run.addEventListener('click', () => void this.runCell(v));
      gutter.append(run, badge);
      this.buildCodeBody(v);
    }

    const existing = outputText(cell);
    outEl.textContent = existing;
    outEl.hidden = existing === '';
    body.append(outEl);

    root.append(gutter, body, this.buildTools(v));
    return v;
  }

  private buildCodeBody(v: CellView) {
    v.editor = new EditorView({
      doc: cellCode(v.cell),
      extensions: [
        keymap.of([
          { key: 'Shift-Enter', run: () => (void this.runCell(v), true) },
        ]),
        minimalSetup,
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
    const view = document.createElement('div');
    view.className = 'prose';
    const render = () => {
      const prose = textProse(v.cell).trim();
      view.innerHTML = prose === '' ? '<p class="empty">Click to write…</p>' : md.render(prose);
    };
    render();
    view.addEventListener('click', () => {
      const area = document.createElement('textarea');
      area.value = textProse(v.cell).replace(/\n$/, '');
      area.rows = Math.max(3, area.value.split('\n').length + 1);
      view.replaceWith(area);
      area.focus();
      area.addEventListener('blur', () => {
        setProse(v.cell, area.value);
        this.onChange();
        render();
        area.replaceWith(view);
      });
    });
    v.body.append(view);
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
    add('+code', 'Insert code cell below', () => this.insertAfter(v, 'program'));
    add('+text', 'Insert text cell below', () => this.insertAfter(v, 'text'));
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
    add('✕', 'Delete cell', () => this.remove(v));
    return tools;
  }

  // ---------- structure edits ----------

  private insertAfter(after: CellView, kind: 'program' | 'text') {
    const cell: Cell =
      kind === 'text'
        ? { kind, marker: '# %% [markdown]', source: ['# '], output: [], trailing: [] }
        : { kind, marker: '# %%', source: [''], output: [], trailing: [] };
    // Keep a blank separator line at the end of the cell above.
    const seg = after.cell.output.length ? after.cell.trailing : after.cell.source;
    if (seg[seg.length - 1]?.trim() !== '') seg.push('');

    const i = this.views.indexOf(after);
    this.doc.cells.splice(i + 1, 0, cell);
    const view = this.buildView(cell);
    this.views.splice(i + 1, 0, view);
    after.root.after(view.root);
    if (kind === 'program') {
      view.stale = true;
      this.refreshBadge(view);
    }
    this.onChange();
  }

  private remove(v: CellView) {
    const i = this.views.indexOf(v);
    this.doc.cells.splice(i, 1);
    this.views.splice(i, 1);
    v.editor?.destroy();
    v.root.remove();
    this.markStaleFromIndex(i);
    this.onChange();
    if (this.views.length === 0) this.setDocKeepingName();
  }

  private setDocKeepingName() {
    // Never leave an empty container: a document is at least one cell.
    const doc = this.doc;
    const cell: Cell = { kind: 'program', marker: '# %%', source: [''], output: [], trailing: [] };
    doc.cells.push(cell);
    const view = this.buildView(cell);
    this.views.push(view);
    this.appendView(view);
  }

  private rebuild(v: CellView) {
    const fresh = this.buildView(v.cell);
    fresh.stale = v.cell.kind === 'program';
    v.editor?.destroy();
    v.root.replaceWith(fresh.root);
    this.views[this.views.indexOf(v)] = fresh;
    this.refreshBadge(fresh);
  }

  private appendView(v: CellView) {
    this.container.append(v.root);
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
    v.root.classList.toggle('stale', v.stale);
    v.root.classList.toggle('running', v.running);
  }
}
