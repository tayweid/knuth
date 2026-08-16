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
import { Compartment, type Extension } from '@codemirror/state';
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
import { icon } from './icons.ts';
import { clearSafeSvgImages, createSafeSvgImage } from './safe-svg.ts';

// Stored-output cap (the DESIGN.md truncation policy).
const MAX_OUTPUT_LINES = 40;
const MAX_LIVE_OUTPUT_CHARS = 100_000;

// Figure receipt lines in output blocks: figs/<name>.svg references.
const FIG_REF = /^figs\/[\w.-]+\.svg$/;

function truncate(text: string, limitReached = false): string {
  // Memory addresses in reprs change every run; receipts must not churn.
  text = text.replace(/0x[0-9a-fA-F]{6,}/g, '0x…');
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines.length <= MAX_OUTPUT_LINES && !limitReached) return lines.join('\n');
  const kept = lines.slice(0, MAX_OUTPUT_LINES);
  if (limitReached) {
    kept.push('… (output display limit reached)');
  } else {
    kept.push(`… (+${lines.length - MAX_OUTPUT_LINES} more lines)`);
  }
  return kept.join('\n');
}

interface CellView {
  cell: Cell;
  /** Wrapper: insert strip + the cell row. */
  root: HTMLElement;
  row: HTMLElement;
  body: HTMLElement;
  outEl: HTMLPreElement;
  figsEl: HTMLElement;
  /** SVGs displayed under this cell (stashed so reloads keep them). */
  figSvgs?: string[];
  /** The implicit cell zero: a plain script's whole body (or a jupytext
   *  header) — runnable and editable, but never given a marker or a
   *  stored output block, so the file stays byte-identical. */
  isPreamble?: boolean;
  badge: HTMLElement;
  editor?: EditorView;
  /** Language/placeholder live in a compartment so kind switches keep the
   *  same editor — and with it, the undo history. */
  lang: Compartment;
  stale: boolean;
  running: boolean;
}

type NewCellKind = 'program' | 'scratch' | 'text';

const KIND_MARKERS: Record<NewCellKind, string> = {
  program: '# %%',
  scratch: '# %% scratch',
  text: '# %% [markdown]',
};

// Kind conversion never clobbers a marker carrying a title/attributes.
const BARE_MARKERS = new Set(Object.values(KIND_MARKERS));

export class DocumentView {
  doc: KnuthDocument = parseDocument('# %%\n');
  private views: CellView[] = [];
  private preambleView: CellView | null = null;
  private endZone!: HTMLElement;
  private lastFocused: CellView | null = null;
  /** Esc arms a brief chord: the next key can switch the cell's kind. */
  private armed: { v: CellView; until: number } | null = null;

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
    /** Resolve a figs/<name>.svg receipt to SVG text (project folder). */
    private loadFigure?: (path: string) => Promise<string | null>,
  ) {
    // The armed Esc chord (Esc, then Y/S/M) is resolved here so it works
    // regardless of which element ends up with the key event.
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.armed || Date.now() > this.armed.until) return;
        const kind =
          e.key === 'y' || e.key === 'c'
            ? 'program'
            : e.key === 's'
              ? 'scratch'
              : e.key === 'm' || e.key === 't'
                ? 'text'
                : null;
        const { v } = this.armed;
        this.disarm();
        if (kind) {
          e.preventDefault();
          e.stopPropagation();
          this.convertKind(v, kind);
        }
      },
      { capture: true },
    );
  }

  private arm(v: CellView) {
    this.disarm();
    this.armed = { v, until: Date.now() + 2000 };
    v.row.classList.add('armed');
    window.setTimeout(() => {
      if (this.armed?.v === v && Date.now() >= this.armed.until) this.disarm();
    }, 2100);
  }

  private disarm() {
    this.armed?.v.row.classList.remove('armed');
    this.armed = null;
  }

  /** Switch a cell's kind in place. The editor (and its undo history)
   *  survives: only the language compartment and the chrome change. */
  convertKind(v: CellView, kind: NewCellKind): void {
    const cell = v.cell;
    if (cell.kind === kind || !BARE_MARKERS.has(cell.marker) || !v.editor) return;
    const wasText = cell.kind === 'text';
    const nowText = kind === 'text';
    cell.kind = kind;
    cell.marker = KIND_MARKERS[kind];
    if (wasText !== nowText) {
      if (nowText) {
        // Outputs don't survive becoming text; trailing blank lines would
        // turn into '#' lines, so trim them (one undoable step).
        const text = v.editor.state.doc.toString();
        const trimmed = text.replace(/\n+$/, '');
        if (trimmed !== text) {
          v.editor.dispatch({ changes: { from: trimmed.length, to: text.length } });
        }
        setOutput(cell, null);
        cell.output = [];
        v.outEl.hidden = true;
        v.outEl.textContent = '';
      }
      v.editor.dispatch({ effects: v.lang.reconfigure(this.langFor(kind)) });
    }
    this.syncModel(v, v.editor.state.doc.toString());
    v.stale = kind === 'program';
    v.row.className = `cell kind-${kind}`;
    v.row.querySelector('.tools')?.replaceWith(this.buildTools(v));
    this.refreshBadge(v);
    v.editor.focus();
    this.onChange();
  }

  private langFor(kind: NewCellKind): Extension {
    return kind === 'text' ? [markdown(), placeholder('Write…')] : python();
  }

  /** Editor text -> document model, by the cell's current kind. The
   *  editor never shows separator blank lines; the model re-adds one at
   *  the end (unless the output block's `trailing` already holds it) so
   *  the raw file keeps breathing room between cells. */
  private syncModel(v: CellView, text: string) {
    if (v.isPreamble) {
      const lines = text.replace(/\n+$/, '').split('\n');
      if (this.views.length > 0) lines.push('');
      this.doc.preamble = lines;
      return;
    }
    if (v.cell.kind === 'text') {
      setProse(v.cell, text);
    } else {
      v.cell.source = text.replace(/\n+$/, '').split('\n');
    }
    if (v.cell.output.length === 0) v.cell.source.push('');
  }

  setDoc(doc: KnuthDocument) {
    for (const v of this.views) {
      clearSafeSvgImages(v.figsEl);
      v.editor?.destroy();
    }
    if (this.preambleView) clearSafeSvgImages(this.preambleView.figsEl);
    this.preambleView?.editor?.destroy();
    this.views = [];
    this.preambleView = null;
    this.container.textContent = '';
    this.doc = doc;
    this.endZone = this.buildZone(null);
    this.container.append(this.endZone);
    // A plain script (or jupytext header) is the implicit cell zero —
    // without this, a markerless .py renders as a blank sheet.
    if (doc.preamble.some((l) => l.trim() !== '')) {
      const pseudo: Cell = {
        kind: 'program',
        marker: '',
        source: [...doc.preamble],
        output: [],
        trailing: [],
      };
      this.preambleView = this.buildView(pseudo, true);
      this.endZone.before(this.preambleView.root);
    }
    for (const cell of doc.cells) {
      const view = this.buildView(cell);
      this.views.push(view);
      this.endZone.before(view.root);
    }
    // A fresh page means a fresh session: nothing has run yet.
    this.markAllStale();
  }

  private allRunnable(): CellView[] {
    return this.preambleView ? [this.preambleView, ...this.views] : [...this.views];
  }

  markAllStale() {
    for (const v of this.allRunnable()) {
      if (v.cell.kind === 'program') v.stale = true;
      this.refreshBadge(v);
    }
  }

  async runAllProgram() {
    for (const v of this.allRunnable()) {
      if (v.cell.kind !== 'program') continue;
      const outcome = await this.runCell(v);
      if (!outcome) break; // error or interrupt: stop the replay
    }
  }

  async runStale() {
    for (const v of this.allRunnable()) {
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
    clearSafeSvgImages(v.figsEl);
    v.figsEl.hidden = true;
    v.figSvgs = undefined;
    let text = '';
    let outputLimitReached = false;
    const appendOutput = (chunk: string) => {
      const available = MAX_LIVE_OUTPUT_CHARS - text.length;
      if (available <= 0) {
        outputLimitReached = true;
        return;
      }
      text += chunk.slice(0, available);
      if (chunk.length > available) outputLimitReached = true;
    };
    let named: string[] = [];
    const outcome = await this.kernel.run(
      cellCode(v.cell),
      {
        onStream: (_which, chunk) => {
          appendOutput(chunk);
          v.outEl.textContent = truncate(text, outputLimitReached);
        },
        onFigures: (svgs, n) => {
          this.renderFigures(v, svgs);
          named = n;
        },
      },
      { scratch: v.cell.kind === 'scratch' },
    );
    if (outcome.ok && outcome.result !== null) {
      appendOutput((text === '' || text.endsWith('\n') ? '' : '\n') + outcome.result);
    }
    if (!outcome.ok && outcome.traceback) {
      appendOutput((text === '' || text.endsWith('\n') ? '' : '\n') + outcome.traceback);
    }
    // Stored output = text readout + figure receipts (figs/<name>.svg
    // paths); the visible pre carries only the text — cards carry figures.
    // The preamble cell displays but never stores (no marker to anchor
    // an output block; the file must stay byte-identical).
    const shown = truncate(text, outputLimitReached);
    if (!v.isPreamble) {
      const refs = outcome.ok ? named.map((n) => `figs/${n}.svg`) : [];
      const stored = [shown, ...refs].filter((s) => s !== '').join('\n');
      setOutput(v.cell, stored === '' ? null : stored);
    }
    v.outEl.textContent = shown;
    v.outEl.hidden = shown === '';
    v.outEl.classList.toggle('error', !outcome.ok);
    v.running = false;
    if (outcome.ok && v.cell.kind === 'program') v.stale = false;
    this.refreshBadge(v);
    if (!v.isPreamble) this.onChange();
    if (outcome.ok && v.cell.kind === 'program') this.onProgramRun?.();
    this.onRun?.();
    return outcome.ok;
  }

  /** Stored output -> display: text lines to the readout, figure receipt
   *  lines resolved from the project folder into cards (when possible). */
  private hydrateOutputs(v: CellView) {
    const lines = outputText(v.cell).split('\n');
    const refs = lines.filter((l) => FIG_REF.test(l.trim()));
    const text = lines.filter((l) => !FIG_REF.test(l.trim())).join('\n');
    v.outEl.textContent = text;
    v.outEl.hidden = text === '';
    if (refs.length > 0 && this.loadFigure) {
      void Promise.all(refs.map((r) => this.loadFigure!(r.trim()))).then((results) => {
        const svgs = results.filter((s): s is string => s !== null && s !== '');
        if (svgs.length > 0) this.renderFigures(v, svgs);
      });
    }
  }

  /** Re-resolve every cell's figure receipts (e.g. after Folder attach). */
  hydrateAll() {
    for (const v of this.views) this.hydrateOutputs(v);
  }

  /** The kernel's SVG renders of the user's figures, shown under the cell. */
  private renderFigures(v: CellView, svgs: string[]) {
    v.figSvgs = svgs;
    clearSafeSvgImages(v.figsEl);
    let rendered = 0;
    for (const svg of svgs) {
      const image = createSafeSvgImage(svg);
      if (!image) continue;
      const holder = document.createElement('div');
      holder.className = 'figure';
      holder.append(image);
      v.figsEl.append(holder);
      rendered += 1;
    }
    v.figsEl.hidden = rendered === 0;
  }

  /** Per-cell displayed figures, for the session stash. */
  collectFigures(): Array<string[] | null> {
    return this.views.map((v) => (v.figSvgs?.length ? v.figSvgs : null));
  }

  /** Reapply stashed figures after a reload's document restore. */
  restoreFigures(figures: Array<string[] | null>) {
    figures.forEach((svgs, i) => {
      const v = this.views[i];
      if (v && svgs?.length) this.renderFigures(v, svgs);
    });
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

  private buildView(cell: Cell, isPreamble = false): CellView {
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
    const figsEl = document.createElement('div');
    figsEl.className = 'cell-figures';
    figsEl.hidden = true;

    const v: CellView = {
      cell,
      root,
      row,
      body,
      outEl,
      figsEl,
      badge,
      lang: new Compartment(),
      stale: false,
      running: false,
      isPreamble,
    };

    // One skeleton for every kind — CSS shows/hides per kind, so a kind
    // switch is a class change, not a rebuild.
    const run = document.createElement('button');
    run.className = 'run';
    run.textContent = '▶';
    run.title = 'Run cell (Cmd-Enter)';
    run.addEventListener('click', () => void this.runCell(v));
    gutter.append(run, badge);

    const label = document.createElement('div');
    label.className = 'scratch-label';
    label.textContent = 'scratch';
    body.append(label);
    this.buildEditor(v);

    body.append(figsEl, outEl);
    this.hydrateOutputs(v);

    row.append(gutter, body, this.buildTools(v));
    // No insert strip above the preamble: nothing can precede cell zero.
    if (isPreamble) root.append(row);
    else root.append(this.buildZone(v), row);
    return v;
  }

  private buildEditor(v: CellView) {
    // Trailing blank lines are inter-cell separators, not content: they
    // stay in the model and out of the editor (phantom empty lines made
    // cell heights and spacing uneven).
    const raw = v.cell.kind === 'text' ? textProse(v.cell) : cellCode(v.cell);
    const initial = raw.replace(/\n+$/, '');
    v.editor = new EditorView({
      doc: initial,
      extensions: [
        this.cellKeymap(v),
        this.trackFocus(v),
        minimalSetup,
        oneDark,
        v.lang.of(this.langFor(v.cell.kind)),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          this.syncModel(v, update.state.doc.toString());
          this.markStaleFrom(v); // no-op for scratch/text
          this.onChange();
        }),
      ],
    });
    v.body.append(v.editor.dom);
  }

  /** Insert after the cell the user is (or was last) working in. */
  insertRelative(kind: NewCellKind) {
    const anchor =
      this.lastFocused && this.views.includes(this.lastFocused)
        ? this.lastFocused
        : this.views[this.views.length - 1];
    if (anchor) this.insertAfter(anchor, kind);
    else this.insertAtEnd(kind);
  }

  private trackFocus(v: CellView) {
    return EditorView.domEventHandlers({
      focus: () => {
        this.lastFocused = v;
        return false;
      },
    });
  }

  private cellKeymap(v: CellView) {
    // One keymap for every kind, branching at press time — the editor
    // survives kind switches, so its bindings must too.
    const isText = () => v.cell.kind === 'text';
    return keymap.of([
      { key: 'Mod-Enter', run: () => (isText() ? false : (void this.runCell(v), true)) },
      {
        key: 'Shift-Enter',
        run: () => {
          if (isText()) this.focusAfter(v, true);
          else this.runAndAdvance(v);
          return true;
        },
      },
      { key: 'Alt-Enter', run: () => (isText() ? false : (this.runAndInsertBelow(v), true)) },
      { key: 'Mod-Shift-Enter', run: () => (this.insertAfter(v, 'program'), true) },
      { key: 'Backspace', run: () => this.backspaceOnEmpty(v) },
      { key: 'Escape', run: () => (this.arm(v), true) },
    ]);
  }

  /** Backspace in an empty cell deletes it (Jupyter's affordance) and
   *  moves focus up; the deletion is restorable via onCellDeleted. */
  private backspaceOnEmpty(v: CellView): boolean {
    if (v.isPreamble) {
      if (v.editor && v.editor.state.doc.length === 0) {
        this.doc.preamble = [];
        v.editor.destroy();
        v.root.remove();
        this.preambleView = null;
        if (this.views.length === 0) this.insertAtEnd('program');
        else this.views[0].editor?.focus();
        this.onChange();
        return true;
      }
      return false;
    }
    if (v.editor && v.editor.state.doc.length === 0 && this.views.length > 1) {
      const prev = this.views[this.views.indexOf(v) - 1] ?? this.views[1];
      this.remove(v);
      prev?.editor?.focus();
      return true;
    }
    return false;
  }

  private buildTools(v: CellView): HTMLElement {
    const tools = document.createElement('div');
    tools.className = 'tools';
    // Kind picker: the cell's identity, switchable in place (also via
    // Esc then Y/S/M). Hidden for markers carrying titles/attributes.
    if (!BARE_MARKERS.has(v.cell.marker)) return tools;
    const kinds: Array<[NewCellKind, string, string, string]> = [
      ['program', 'code', 'Code', 'Code cell (Esc, Y)'],
      ['scratch', 'scratch', 'Scratch', 'Scratch cell — never persists (Esc, S)'],
      ['text', 'text', 'Text', 'Text cell (Esc, M)'],
    ];
    for (const [kind, glyph, label, title] of kinds) {
      const b = document.createElement('button');
      b.className = 'kind-pick' + (v.cell.kind === kind ? ' cur' : '');
      b.title = title;
      b.innerHTML = `${icon(glyph)}<span class="lbl">${label}</span>`;
      b.addEventListener('click', () => this.convertKind(v, kind));
      tools.append(b);
    }
    return tools;
  }

  /** Hover strip that inserts a cell before `v` (or at the end for null):
   *  a hairline with a small glass pill of kind icons, the same dialect
   *  as the toolbar and the kind picker. */
  private buildZone(v: CellView | null): HTMLElement {
    const zone = document.createElement('div');
    zone.className = 'insert-zone';
    const inner = document.createElement('div');
    inner.className = 'insert-actions';
    const kinds: Array<[NewCellKind, string, string, string]> = [
      ['program', 'code', 'Code', 'Insert code cell'],
      ['scratch', 'scratch', 'Scratch', 'Insert scratch cell'],
      ['text', 'text', 'Text', 'Insert text cell'],
    ];
    for (const [kind, glyph, label, title] of kinds) {
      const b = document.createElement('button');
      b.title = title;
      b.innerHTML = `${icon(glyph)}<span class="lbl">${label}</span>`;
      b.addEventListener('click', () => {
        if (v) this.insertBefore(v, kind);
        else this.insertAtEnd(kind);
      });
      inner.append(b);
    }
    zone.append(inner);
    return zone;
  }

  // ---------- structure edits ----------

  private newCell(kind: NewCellKind): Cell {
    const marker =
      kind === 'text' ? '# %% [markdown]' : kind === 'scratch' ? '# %% scratch' : '# %%';
    return { kind, marker, source: [''], output: [], trailing: [] };
  }

  /** Keep a blank separator line at the end of the cell above the gap. */
  private ensureSeparator(prev: CellView | undefined) {
    if (!prev) return;
    const seg = prev.cell.output.length ? prev.cell.trailing : prev.cell.source;
    if (seg[seg.length - 1]?.trim() !== '') seg.push('');
  }

  private insertAt(i: number, kind: NewCellKind) {
    const cell = this.newCell(kind);
    this.ensureSeparator(this.views[i - 1]);
    // First cell after a preamble: the preamble supplies the separator.
    if (i === 0 && this.preambleView) {
      const p = this.doc.preamble;
      if (p[p.length - 1]?.trim() !== '') p.push('');
    }
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

  private insertAfter(v: CellView, kind: NewCellKind) {
    this.insertAt(this.views.indexOf(v) + 1, kind);
  }

  private insertBefore(v: CellView, kind: NewCellKind) {
    this.insertAt(this.views.indexOf(v), kind);
  }

  private insertAtEnd(kind: NewCellKind) {
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
