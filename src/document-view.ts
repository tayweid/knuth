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
import {
  Decoration,
  GutterMarker,
  keymap,
  lineNumberMarkers,
  lineNumbers,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { Compartment, RangeSet, RangeSetBuilder, type Extension } from '@codemirror/state';
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { foldGutter, foldKeymap, indentUnit } from '@codemirror/language';
import { indentationMarkers } from '@replit/codemirror-indentation-markers';
import { python, pythonLanguage } from '@codemirror/lang-python';
import { yaml, yamlFrontmatter, yamlLanguage } from '@codemirror/lang-yaml';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  EditorView as PMEditorView,
  Decoration as PMDecoration,
  DecorationSet as PMDecorationSet,
} from 'prosemirror-view';
import { EditorState, Plugin as PMPlugin, TextSelection, type Command as PMCommand } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { keymap as pmKeymap } from 'prosemirror-keymap';
import { history } from 'prosemirror-history';
import { proseInputRules, proseKeymap, copyTextWithoutItsBlock } from './prose/editing.ts';
import { mdToDoc } from './prose/md-parser.ts';
import { docToMd } from './prose/md-serializer.ts';
import { MathView } from './prose/math-view.ts';
import {
  type Cell,
  type KnuthDocument,
  parseDocument,
  serializeDocument,
  cellCode,
  scratchCode,
  setScratchCode,
  textProse,
  setProse,
  setOutput,
  outputText,
} from './format/percent.ts';
import type { Kernel, NamespaceVar } from './kernel/kernel.ts';
import { findHeader, headerPackages } from './header.ts';
import { GridView, GridHistory } from './grid.ts';
import { icon } from './icons.ts';
import { clearSafeSvgImages, createSafeSvgImage } from './safe-svg.ts';

/** Markdown as Quarto/R Markdown write it: a YAML front matter block
 *  over the prose, and code fences whose info string is braced —
 *  ```{python} — so the fence's language is read with the braces (and
 *  any chunk options after a comma or space) stripped. */
function quartoMarkdown(): Extension {
  const content = markdown({
    codeLanguages: (info) => {
      const lang = info.replace(/^\{/, '').split(/[\s,}]/)[0].toLowerCase();
      if (lang === 'python' || lang === 'py') return pythonLanguage;
      if (lang === 'yaml' || lang === 'yml') return yamlLanguage;
      return null;
    },
  });
  return yamlFrontmatter({ content });
}

/** The grammar for a plain (non-.py) file, by its name — null when the
 *  editor has none for it and the file is numbered, wrapped text. */
export function plainLanguageFor(name: string): Extension | null {
  if (/\.ya?ml$/i.test(name)) return yaml();
  if (/\.(md|markdown|qmd|rmd)$/i.test(name)) return quartoMarkdown();
  return null;
}

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

/** One finished run, for the session's receipt of it (session.ts): which
 *  cell, how long, whether it finished cleanly, what the kernel says it
 *  bound, the figures it drew and their figs/ names, and whether it was
 *  one of a Run all / Run stale (a batch never unfolds a receipt card). */
export interface RunInfo {
  id: string;
  ms: number;
  ok: boolean;
  scratch: boolean;
  bound?: NamespaceVar[];
  figures: string[];
  named: string[];
  batch: boolean;
}

interface CellView {
  cell: Cell;
  /** The cell's identity for the session's receipts and chips: minted
   *  once per Cell object (a kind switch keeps the view, a delete-restore
   *  the Cell), so a receipt finds its cell again. */
  id: string;
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
  /** Program/scratch cells (and the source-view pseudo-cell). */
  editor?: EditorView;
  /** Text cells: an always-editable ProseMirror view: no rendered/edit
   *  split, no overlay — the doc it holds IS the cell. */
  prose?: PMEditorView;
  /** Language/placeholder live in a compartment so kind switches keep the
   *  same editor — and with it, the undo history. */
  lang: Compartment;
  stale: boolean;
  running: boolean;
  /** Between runs, on the cell's behalf: uv adding or downloading a
   *  package its import needs, before the cell runs again. */
  working: boolean;
}

/** An empty doc is the schema's default: one paragraph, no content. */
function isEmptyProseDoc(doc: PMNode): boolean {
  const first = doc.firstChild;
  return doc.childCount === 1 && !!first && first.content.size === 0;
}

/** 'Write…' for an empty text cell: a `data-placeholder` node decoration on
 *  the lone empty paragraph (CSS renders it via ::before) — PM's own
 *  trailing-break span keeps the <p> non-empty, so :empty is no use here. */
function textPlaceholder(text: string): PMPlugin {
  return new PMPlugin({
    props: {
      decorations(state) {
        if (!isEmptyProseDoc(state.doc)) return null;
        const first = state.doc.firstChild!;
        return PMDecorationSet.create(state.doc, [
          PMDecoration.node(0, first.nodeSize, { 'data-placeholder': text }),
        ]);
      },
    },
  });
}

type NewCellKind = 'program' | 'scratch' | 'text';

const KIND_MARKERS: Record<NewCellKind, string> = {
  program: '# %%',
  scratch: '# %% scratch',
  text: '# %% [markdown]',
};

// Kind conversion never clobbers a marker carrying a title/attributes.
const BARE_MARKERS = new Set(Object.values(KIND_MARKERS));

/** Wrapped continuations honor the line's indent plus one extra unit, so
 *  the back half of a long line lands deeper than any real code at that
 *  level could (bodies step by exactly 4) — visibly a continuation, the
 *  same idiom as PEP 8's own continuation indents. VS Code calls this
 *  wrappingIndent: 'indent'; vim calls it breakindent. The mechanism is
 *  the classic pair: pad the line block by the hang, pull the first
 *  visual row back by the same amount. */
function hangDeco(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      if (line.length) {
        const hang = /^ */.exec(line.text)![0].length + 4;
        builder.add(
          line.from,
          line.from,
          Decoration.line({
            attributes: {
              style: `text-indent:-${hang}ch;padding-left:calc(${hang}ch + 0.75rem)`,
            },
          }),
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** The run control lives IN the line-number gutter, as line 1's marker:
 *  it inherits the column's real width (two digits or three), sits
 *  centered on line 1 — which IS the gutter's center for a one-line
 *  cell — and stays pinned there however tall the cell grows. Its glyph
 *  and colors are CSS (.cell.running flips ▶ to ■). */
class RunMarker extends GutterMarker {
  constructor(private onClick: () => void) {
    super();
  }
  toDOM() {
    // A marker REPLACES the line number it sits on, so the slot carries
    // the digit itself: wherever the button is hidden (source view),
    // line 1 keeps its plain number.
    const slot = document.createElement('span');
    slot.className = 'run-slot';
    const num = document.createElement('span');
    num.className = 'run-num';
    num.textContent = '1';
    const button = document.createElement('button');
    button.className = 'run';
    button.title = 'Run cell (Cmd-Enter) — interrupts while running';
    button.addEventListener('click', (e) => {
      e.preventDefault();
      this.onClick();
    });
    slot.append(num, button);
    return slot;
  }
}

const wrapHang = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = hangDeco(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = hangDeco(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Jedi's kinds, in CodeMirror's icon vocabulary. */
const COMPLETION_KIND: Record<string, string> = {
  module: 'namespace',
  class: 'class',
  function: 'function',
  instance: 'variable',
  statement: 'variable',
  param: 'variable',
  property: 'property',
  keyword: 'keyword',
  path: 'text',
};

export class DocumentView {
  doc: KnuthDocument = parseDocument('# %%\n');
  private views: CellView[] = [];
  private preambleView: CellView | null = null;
  /** Source view: the whole file in one raw editor, markers and receipts
   *  as honest text. Cell view needs markers; source view suits any file. */
  private sourceMode = false;
  /** A non-.py file: always the plain source editor, never the cell
   *  workbench — even if its text happens to contain "# %%" lines. */
  private plainFile = false;
  /** A plain file's grammar (plainLanguageFor), when the editor has one. */
  private plainLanguage: Extension | null = null;
  /** A .csv/.tsv: its delimiter, and with it a grid view on offer. */
  private gridDelimiter: string | null = null;
  /** Whether this document offers the toggle between grid and source. */
  private gridOffered = false;
  /** Showing the grid rather than the source editor. */
  private gridMode = false;
  private grid: GridView | null = null;
  private gridHistory = new GridHistory();
  private endZone!: HTMLElement;
  private lastFocused: CellView | null = null;
  /** Esc arms a brief chord: the next key can switch the cell's kind. */
  private armed: { v: CellView; until: number } | null = null;
  /** Cell identities (CellView.id), by the Cell they belong to. */
  private ids = new WeakMap<Cell, string>();
  private nextId = 1;
  /** Inside a Run all / Run stale. */
  private batch = false;

  constructor(
    private container: HTMLElement,
    private kernel: Kernel,
    private onChange: () => void,
    /** A program cell finished cleanly — namespace/artifacts moved. */
    private onProgramRun?: () => void,
    /** Any code cell finished (ok or not) — the session may have changed;
     *  what the run did, for its receipt. */
    private onRun?: (run: RunInfo) => void,
    /** A structural change happened that the editors' own history cannot
     *  undo (cell deleted, plain file converted to cells); calling
     *  `restore` reverses it. `message` names the ⌘Z on offer. */
    private onUndoable?: (restore: () => void, message: string) => void,
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

  /** Switch a cell's kind in place. Program<->scratch keeps the same CM
   *  editor (and its undo history) — only the language compartment and the
   *  chrome change. Any switch across the text/code line rebuilds the
   *  editor outright: CodeMirror and ProseMirror are different widgets,
   *  so undo history does not survive that crossing. */
  convertKind(v: CellView, kind: NewCellKind): void {
    const cell = v.cell;
    if (cell.kind === kind || !BARE_MARKERS.has(cell.marker) || (!v.editor && !v.prose)) return;
    const wasText = cell.kind === 'text';
    const nowText = kind === 'text';
    let text = v.prose ? docToMd(v.prose.state.doc).replace(/\n+$/, '') : (v.editor?.state.doc.toString() ?? '');

    cell.kind = kind;
    cell.marker = KIND_MARKERS[kind];

    if (wasText !== nowText) {
      if (nowText) {
        // Outputs don't survive becoming text; trailing blank lines would
        // turn into '#' lines, so trim them.
        text = text.replace(/\n+$/, '');
        setOutput(cell, null);
        cell.output = [];
        v.outEl.hidden = true;
        v.outEl.textContent = '';
      }
      v.prose?.destroy();
      v.prose = undefined;
      v.editor?.destroy();
      v.editor = undefined;
      this.syncModel(v, text);
      this.buildEditor(v);
    } else {
      v.editor!.dispatch({ effects: v.lang.reconfigure(this.langFor(v)) });
      this.syncModel(v, text);
    }
    v.stale = kind === 'program';
    v.row.className = `cell kind-${kind}`;
    this.refreshRunControl(v);
    this.focusCell(v);
    this.onChange();
  }

  private langFor(v: CellView): Extension {
    // Code chrome rides the language compartment so a kind switch brings
    // it along: numbers, fold arrows (Python's own parser says what
    // folds — bodies of defs, classes, loops), and indent guides.
    // A plain (non-.py) file is not Python. With a grammar of its own
    // (YAML) it gets the same chrome over that grammar; without one it
    // is just numbered, wrapped text.
    const language = this.plainFile ? this.plainLanguage : python();
    const codeChrome: Extension = language
      ? [
          language,
          foldGutter(),
          indentationMarkers({
            colors: {
              light: 'rgba(0, 0, 0, 0.12)',
              dark: 'rgba(255, 255, 255, 0.09)',
              activeLight: 'rgba(0, 0, 0, 0.28)',
              activeDark: 'rgba(255, 255, 255, 0.22)',
            },
          }),
          keymap.of(foldKeymap),
        ]
      : [];
    return [
      codeChrome,
      // CodeMirror's indent-unit facet defaults to TWO spaces and python()
      // does not correct it — auto-indent was stepping by 2, and the
      // indent guides drew a phantom bar at every half level of 4-space
      // code. Python's unit is four; a plain file's (YAML's) is two.
      indentUnit.of(this.plainFile ? '  ' : '    '),
      wrapHang,
      lineNumbers(),
      lineNumberMarkers.of(RangeSet.of(
        new RunMarker(() => {
          if (v.running) this.kernel.interrupt();
          else if (!v.working) void this.runCell(v);
        }).range(0),
      )),
    ];
  }

  /** Editor text -> document model, by the cell's current kind. The
   *  editor never shows separator blank lines; the model re-adds one at
   *  the end (unless the output block's `trailing` already holds it) so
   *  the raw file keeps breathing room between cells. */
  /** The body carries the view for CSS: 'source' strips the notebook
   *  chrome down to one raw editor. data-cells gates the floating toggle
   *  into cell view on whether the text has markers to act on. */
  private syncView() {
    document.body.dataset.view = this.gridMode ? 'grid' : this.sourceMode ? 'source' : '';
    document.body.dataset.cells =
      !this.plainFile && this.doc.cells.length > 0 ? 'true' : '';
    document.body.dataset.plain = this.plainFile ? 'true' : '';
    // data-grid gates the toggle between grid and source the way
    // data-cells gates the one between source and cells.
    document.body.dataset.grid = this.gridOffered ? 'true' : '';
  }

  private syncModel(v: CellView, text: string) {
    if (v.isPreamble) {
      if (this.sourceMode) {
        // Raw edits invalidate the grid's line offsets. Merely toggling
        // views keeps its history intact.
        this.gridHistory.clear();
        // Source view edits the raw file. Reparse for the model — saving
        // serializes it back byte-identically — but never rebuild the
        // view: the editor's undo history survives, and cell view is a
        // deliberate toggle (setSource), not a side effect of typing.
        const raw = text.replace(/\n+$/, '');
        const reparsed = parseDocument(raw === '' ? '' : raw + '\n');
        reparsed.trailingNewline = this.doc.trailingNewline;
        this.doc = reparsed;
        this.syncView();
        return;
      }
      const lines = text.replace(/\n+$/, '').split('\n');
      if (this.views.length > 0) lines.push('');
      this.doc.preamble = lines;
      return;
    }
    if (v.cell.kind === 'text') {
      setProse(v.cell, text);
    } else if (v.cell.kind === 'scratch') {
      setScratchCode(v.cell, text.replace(/\n+$/, ''));
    } else {
      v.cell.source = text.replace(/\n+$/, '').split('\n');
    }
    if (v.cell.output.length === 0) v.cell.source.push('');
  }

  /** Pin the document to the plain source editor (non-.py files). Set
   *  before setDoc — it decides which view the document opens in. */
  setPlain(on: boolean, language: Extension | null = null) {
    this.plainFile = on;
    this.plainLanguage = on ? language : null;
  }

  /** Offer the grid view for a delimited file (.csv/.tsv), given its
   *  delimiter — null for a file with no grid to show. Set before
   *  setDoc, like setPlain. */
  setGrid(delimiter: string | null) {
    this.gridDelimiter = delimiter;
  }

  setDoc(doc: KnuthDocument) {
    this.gridHistory.clear();
    this.doc = doc;
    // Open in the view that fits: cells when the file has markers, the
    // raw source editor when it does not — or always, for a plain file.
    this.sourceMode = this.plainFile || doc.cells.length === 0;
    // A delimited file opens as its grid, if the table can carry it.
    this.gridOffered =
      this.plainFile && this.gridDelimiter !== null;
    this.gridMode = this.gridOffered;
    this.render();
    this.onDocument?.();
  }

  /** Replace the preamble alone — a header the engine grew — without
   *  rebuilding the cells, which may be mid-run: the running cell's
   *  output element must stay the one being written. */
  setPreamble(lines: string[]) {
    if (this.gridMode) {
      this.doc.preamble = lines;
      return;
    }
    if (this.sourceMode) {
      const editor = this.preambleView?.editor;
      const before = this.doc.preamble.join('\n');
      const current = editor?.state.doc.toString() ?? '';
      if (!editor || !current.startsWith(before)) {
        this.doc.preamble = lines;
        this.render();
        return;
      }
      // The listener reparses the model from the edited text.
      editor.dispatch({ changes: { from: 0, to: before.length, insert: lines.join('\n') } });
      return;
    }
    this.doc.preamble = lines;
    const editor = this.preambleView?.editor;
    if (editor) {
      const text = lines.join('\n').replace(/\n+$/, '');
      if (editor.state.doc.toString() !== text) {
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
      }
      if (this.preambleView) {
        if (!this.preambleView.root.querySelector(':scope > .packages-summary')) this.foldPackages(this.preambleView);
        else this.paintPackages(this.preambleView);
      }
      return;
    }
    if (!lines.some((line) => line.trim() !== '')) return;
    // The document had no preamble: give it cell zero, above the cells.
    const pseudo: Cell = {
      kind: 'program',
      marker: '',
      source: [...lines],
      output: [],
      trailing: [],
    };
    this.preambleView = this.buildView(pseudo, true);
    (this.views[0]?.root ?? this.endZone).before(this.preambleView.root);
  }

  /** Whether the raw single-editor source view is showing. */
  get isSource(): boolean {
    return this.sourceMode && !this.gridMode;
  }

  /** Switch between the raw source editor and the cell view — or, for a
   *  delimited file, between the source editor and the grid. Cell view
   *  needs markers to act on; without any, the switch refuses. */
  setSource(on: boolean) {
    if (this.gridOffered) {
      if (on === !this.gridMode) return;
      this.gridMode = !on;
      this.render();
      if (this.gridMode) this.grid?.focus();
      else this.focusCell(this.preambleView);
      return;
    }
    if (on === this.sourceMode) return;
    if (!on && (this.plainFile || this.doc.cells.length === 0)) return;
    this.sourceMode = on;
    this.render();
    this.focusCell(this.preambleView ?? this.views[0]);
  }

  private render() {
    for (const v of this.views) {
      clearSafeSvgImages(v.figsEl);
      this.destroyEditors(v);
    }
    if (this.preambleView) clearSafeSvgImages(this.preambleView.figsEl);
    if (this.preambleView) this.destroyEditors(this.preambleView);
    this.grid?.destroy();
    this.grid = null;
    this.views = [];
    this.preambleView = null;
    this.container.textContent = '';
    this.endZone = this.buildZone(null);
    this.container.append(this.endZone);
    this.syncView();
    if (this.gridMode) {
      // The file's physical lines, handed to the grid to edit in place.
      // Each change reparses them for the model (saving serializes it
      // back byte-identically), the way source-view edits do.
      const lines = serializeDocument(this.doc).split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      this.grid = new GridView({
        history: this.gridHistory,
        delimiter: this.gridDelimiter ?? ',',
        lines,
        onChange: (edited) => {
          const text =
            edited.length === 0 ? '' : edited.join('\n') + (this.doc.trailingNewline ? '\n' : '');
          const reparsed = parseDocument(text);
          reparsed.trailingNewline = this.doc.trailingNewline;
          this.doc = reparsed;
          this.onChange();
        },
      });
      this.endZone.before(this.grid.root);
      return;
    }
    if (this.sourceMode) {
      // The whole file in one editor, markers and receipts as honest
      // text; round-tripping makes the reparse on edit lossless.
      const text = serializeDocument(this.doc).replace(/\n+$/, '');
      const pseudo: Cell = {
        kind: 'program',
        marker: '',
        source: text.split('\n'),
        output: [],
        trailing: [],
      };
      this.preambleView = this.buildView(pseudo, true);
      this.endZone.before(this.preambleView.root);
      this.markAllStale();
      return;
    }
    // The jupytext header (or any preamble) is the implicit cell zero —
    // without this it would render as a blank gap above the first cell.
    if (this.doc.preamble.some((l) => l.trim() !== '')) {
      const pseudo: Cell = {
        kind: 'program',
        marker: '',
        source: [...this.doc.preamble],
        output: [],
        trailing: [],
      };
      this.preambleView = this.buildView(pseudo, true);
      this.endZone.before(this.preambleView.root);
    }
    for (const cell of this.doc.cells) {
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
      this.refreshRunControl(v);
    }
  }

  async runAllProgram() {
    this.batch = true;
    try {
      for (const v of this.allRunnable()) {
        if (v.cell.kind !== 'program') continue;
        const outcome = await this.runCell(v);
        if (!outcome) break; // error or interrupt: stop the replay
      }
    } finally {
      this.batch = false;
    }
  }

  async runStale() {
    this.batch = true;
    try {
      for (const v of this.allRunnable()) {
        if (v.cell.kind !== 'program' || !v.stale) continue;
        const outcome = await this.runCell(v);
        if (!outcome) break;
      }
    } finally {
      this.batch = false;
    }
  }

  // ---------- cells by identity (the session's receipts and chips) ----------

  /** Every runnable cell's id, in document order (cell zero first). */
  cellIds(): string[] {
    return this.allRunnable().map((v) => v.id);
  }

  /** A code cell's number as the person counts them: the code cells
   *  only, 1-based, the text cells between them uncounted (no number is
   *  drawn on the page, so a student counts the cells that run); 0 is cell
   *  zero, the preamble. Null for a text cell or once the cell is gone. */
  cellNumber(id: string): number | null {
    if (this.preambleView?.id === id) return 0;
    let n = 0;
    for (const v of this.views) {
      if (v.cell.kind !== 'text') n += 1;
      if (v.id === id) return v.cell.kind === 'text' ? null : n;
    }
    return null;
  }

  /** The cell's row (.cell), where its chip lives, or null once it is gone
   *  or not on screen (source and grid views). */
  cellRow(id: string): HTMLElement | null {
    return this.allRunnable().find((v) => v.id === id)?.row ?? null;
  }

  /** Bring a cell into view and put the cursor in it. */
  goToCell(id: string) {
    const v = this.allRunnable().find((view) => view.id === id);
    if (!v) return;
    v.row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.focusCell(v);
  }

  /** A run is starting in a cell (the session puts the last receipt away). */
  onRunStart?: (id: string) => void;
  /** A cell's row was built (render, insert, restore): the session hangs
   *  its chip there. */
  decorate?: (id: string, row: HTMLElement) => void;
  /** A different document (or the same one fresh from disk): every cell is
   *  a new Cell, so no receipt finds its cell again. */
  onDocument?: () => void;

  private idFor(cell: Cell, isPreamble: boolean): string {
    // Cell zero is rebuilt from the preamble on every render: one id for
    // it in cell view; the source view's whole-file editor is no cell.
    if (isPreamble) return this.sourceMode ? 'source' : 'c0';
    let id = this.ids.get(cell);
    if (!id) {
      id = `c${this.nextId++}`;
      this.ids.set(cell, id);
    }
    return id;
  }

  /** A run failed: its traceback, a way to run the cell again, and a way
   *  to show work done on the cell's behalf in the meantime (its spinner). */
  onRunFailed?: (
    traceback: string,
    rerun: () => Promise<boolean>,
    working: (on: boolean) => void,
  ) => void;

  /** A run completed, cleanly or not: the cell's number in the document
   *  (1-based; 0 is the preamble) and whether it finished cleanly. The
   *  shell's autosave record is told (shell.ts, reportCellRun). */
  onRunDone?: (cell: number, ok: boolean) => void;

  /** Run one code cell; resolves true when it finished cleanly. */
  private async runCell(v: CellView): Promise<boolean> {
    if (v.cell.kind === 'text' || v.running) return false;
    this.onRunStart?.(v.id);
    const batch = this.batch;
    const started = performance.now();
    v.running = true;
    v.working = false;
    this.refreshRunControl(v);
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
    let drawn: string[] = [];
    const outcome = await this.kernel.run(
      v.cell.kind === 'scratch' ? scratchCode(v.cell) : cellCode(v.cell),
      {
        onStream: (_which, chunk) => {
          appendOutput(chunk);
          v.outEl.textContent = truncate(text, outputLimitReached);
        },
        onFigures: (svgs, n) => {
          this.renderFigures(v, svgs);
          named = n;
          drawn = svgs;
        },
      },
      {
        scratch: v.cell.kind === 'scratch',
        // The header travels with the run: the in-tab Python installs
        // what it declares (the engine reads it from disk itself).
        preamble: this.doc.preamble.join('\n'),
      },
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
    this.refreshRunControl(v);
    if (!v.isPreamble) this.onChange();
    if (outcome.ok && v.cell.kind === 'program') this.onProgramRun?.();
    this.onRun?.({
      id: v.id,
      ms: performance.now() - started,
      ok: outcome.ok,
      scratch: v.cell.kind === 'scratch',
      bound: outcome.bound,
      figures: drawn,
      named: outcome.ok ? named : [],
      batch,
    });
    this.onRunDone?.(v.isPreamble ? 0 : this.views.indexOf(v) + 1, outcome.ok);
    if (!outcome.ok && outcome.traceback) {
      this.onRunFailed?.(outcome.traceback, () => this.runCell(v), (on) => {
        v.working = on;
        this.refreshRunControl(v);
      });
    }
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
    if (next) this.focusCell(next);
    else if (createAtEnd) this.insertAfter(v, 'program');
  }

  /** The focusable widget in a cell, CM or PM alike. */
  private focusCell(v: CellView | null | undefined) {
    if (!v) return;
    if (v.prose) v.prose.focus();
    else v.editor?.focus();
  }

  /** Cursor to the very end of a cell, then focus it — ArrowDown/Backspace
   *  landing in the previous cell should not dump the cursor at its start. */
  private focusCellEnd(v: CellView) {
    if (v.prose) {
      const sel = TextSelection.atEnd(v.prose.state.doc);
      v.prose.dispatch(v.prose.state.tr.setSelection(sel));
      v.prose.focus();
    } else if (v.editor) {
      v.editor.dispatch({ selection: { anchor: v.editor.state.doc.length } });
      v.editor.focus();
    }
  }

  /** Cursor to the very start of a cell, then focus it. */
  private focusCellStart(v: CellView) {
    if (v.prose) {
      const sel = TextSelection.atStart(v.prose.state.doc);
      v.prose.dispatch(v.prose.state.tr.setSelection(sel));
      v.prose.focus();
    } else if (v.editor) {
      v.editor.dispatch({ selection: { anchor: 0 } });
      v.editor.focus();
    }
  }

  /** ArrowUp from the first line of a cell: cursor to the end of whatever
   *  precedes it (another cell, or the preamble). false if there's nothing
   *  above — the arrow key falls through to its ordinary behavior. */
  private moveToPrevEnd(v: CellView): boolean {
    const all = this.allRunnable();
    const prev = all[all.indexOf(v) - 1];
    if (!prev) return false;
    this.focusCellEnd(prev);
    return true;
  }

  /** ArrowDown from the last line of a cell: cursor to the start of
   *  whatever follows it. */
  private moveToNextStart(v: CellView): boolean {
    const all = this.allRunnable();
    const next = all[all.indexOf(v) + 1];
    if (!next) return false;
    this.focusCellStart(next);
    return true;
  }

  // ---------- construction ----------

  private buildView(cell: Cell, isPreamble = false): CellView {
    const root = document.createElement('div');
    root.className = 'cell-wrap';

    const row = document.createElement('div');
    row.className = `cell kind-${cell.kind}`;

    const body = document.createElement('div');
    body.className = 'body';
    const outEl = document.createElement('pre');
    outEl.className = 'output';
    const figsEl = document.createElement('div');
    figsEl.className = 'cell-figures';
    figsEl.hidden = true;

    const v: CellView = {
      cell,
      id: this.idFor(cell, isPreamble),
      root,
      row,
      body,
      outEl,
      figsEl,
      lang: new Compartment(),
      stale: false,
      running: false,
      working: false,
      isPreamble,
    };

    const label = document.createElement('div');
    label.className = 'scratch-label';
    label.textContent = 'scratch';
    body.append(label);
    this.buildEditor(v);

    body.append(figsEl, outEl);
    this.hydrateOutputs(v);

    row.append(body);
    root.dataset.cell = v.id;
    // No insert strip above the preamble: nothing can precede cell zero.
    if (isPreamble) root.append(row);
    else root.append(this.buildZone(v), row);
    if (isPreamble && !this.sourceMode) this.foldPackages(v);
    if (!this.sourceMode) this.decorate?.(v.id, row);
    return v;
  }

  /** Open or closed, the package header across re-renders of cell zero. */
  private packagesOpen = false;

  /** A preamble holding the package header folds to one line naming the
   *  packages; a click opens the header itself (Taylor, 2026-09-27). The
   *  header is uv's bookkeeping, there to be read now and then, not a cell
   *  to look at every day. Source view always shows everything. */
  private foldPackages(v: CellView) {
    const summary = document.createElement('button');
    summary.type = 'button';
    summary.className = 'packages-summary';
    summary.addEventListener('mousedown', (event) => event.preventDefault());
    summary.addEventListener('click', () => {
      this.packagesOpen = !this.packagesOpen;
      this.paintPackages(v);
    });
    v.root.prepend(summary);
    this.paintPackages(v);
  }

  private paintPackages(v: CellView) {
    const summary = v.root.querySelector<HTMLButtonElement>(':scope > .packages-summary');
    if (!summary) return;
    const lines = this.doc.preamble;
    const hasHeader = findHeader(lines) !== null;
    summary.hidden = !hasHeader;
    v.root.classList.toggle('packages-folded', hasHeader && !this.packagesOpen);
    if (!hasHeader) return;
    const packages = headerPackages(lines);
    summary.textContent = '';
    const chevron = document.createElement('span');
    chevron.className = 'chevron';
    chevron.textContent = this.packagesOpen ? '▾' : '▸';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Packages';
    const list = document.createElement('span');
    list.className = 'list';
    list.textContent = packages.length ? packages.join(' · ') : 'none yet';
    summary.append(chevron, label, list);
    summary.title = this.packagesOpen ? 'Hide the package header' : 'Show the package header';
  }

  private buildEditor(v: CellView) {
    if (v.cell.kind === 'text') {
      this.buildProse(v);
      return;
    }
    // Trailing blank lines are inter-cell separators, not content: they
    // stay in the model and out of the editor (phantom empty lines made
    // cell heights and spacing uneven).
    const raw = v.cell.kind === 'scratch' ? scratchCode(v.cell) : cellCode(v.cell);
    const initial = raw.replace(/\n+$/, '');
    v.editor = new EditorView({
      doc: initial,
      extensions: [
        this.cellKeymap(v),
        this.trackFocus(v),
        minimalSetup,
        oneDark,
        v.lang.of(this.langFor(v)),
        EditorView.lineWrapping,
        autocompletion({ override: [(context) => this.completions(context)], icons: true }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          this.syncModel(v, update.state.doc.toString());
          this.markStaleFrom(v); // no-op for scratch
          this.onChange();
        }),
      ],
    });
    v.body.append(v.editor.dom);
  }

  /** Code hints: what fits at the cursor, from the live session (the
   *  kernel's knuth.complete — Jedi, or the standard library's completer).
   *  Offered after a "." or two typed letters, and on Ctrl-Space. */
  private async completions(context: CompletionContext): Promise<CompletionResult | null> {
    if (this.plainFile || !this.kernel.complete || !this.kernel.isReady) return null;
    const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/);
    const afterDot = context.state.sliceDoc(Math.max(0, (word?.from ?? context.pos) - 1), word?.from ?? context.pos) === '.';
    if (!context.explicit && !afterDot && (!word || word.to - word.from < 2)) return null;
    const result = await this.kernel.complete(context.state.doc.toString(), context.pos);
    if (!result || context.aborted || result.items.length === 0) return null;
    return {
      from: Math.min(result.start, context.pos),
      options: result.items.map((item) => ({ label: item.label, type: COMPLETION_KIND[item.type] ?? 'variable' })),
      validFor: /^[A-Za-z0-9_]*$/,
    };
  }

  /** A text cell is an always-editable ProseMirror view — no rendered/edit
   *  split, no overlay: the doc it holds IS the cell. */
  private buildProse(v: CellView) {
    const state = EditorState.create({
      doc: mdToDoc(textProse(v.cell)).doc,
      plugins: [
        // First, so its Shift-Enter/Backspace/Escape/arrow bindings beat
        // proseKeymap's own (hard-break Shift-Enter, joining Backspace).
        pmKeymap(this.textCellKeymap(v)),
        proseInputRules,
        proseKeymap,
        history(),
        copyTextWithoutItsBlock(),
        textPlaceholder('Write…'),
      ],
    });
    let view!: PMEditorView;
    view = new PMEditorView(null, {
      state,
      nodeViews: {
        math_inline: (node, nv, getPos) => new MathView(node, nv, getPos),
        math_display: (node, nv, getPos) => new MathView(node, nv, getPos),
      },
      handleDOMEvents: {
        focus: () => {
          this.lastFocused = v;
          return false;
        },
        mousedown: (_pv, event) => this.openLinkOnModifierClick(event),
      },
      // Round-trip honesty: reserialize only on a real doc change, never on
      // a bare selection/focus transaction (that would be pointless churn
      // and risks the file changing under a click that touched nothing).
      dispatchTransaction: (tr) => {
        const next = view.state.apply(tr);
        view.updateState(next);
        if (!tr.docChanged) return;
        this.syncModel(v, docToMd(next.doc).replace(/\n+$/, ''));
        this.markStaleFrom(v); // no-op for text
        this.onChange();
      },
    });
    v.prose = view;
    v.body.append(view.dom);
  }

  /** Cmd/Ctrl-click a link to open it beside the app, same as prose links
   *  always have — never inside the contenteditable, which would just move
   *  the caret there. http(s) only; never hand the tab a `window.opener`. */
  private openLinkOnModifierClick(event: MouseEvent): boolean {
    if (!(event.metaKey || event.ctrlKey)) return false;
    const anchor = (event.target as HTMLElement).closest('a[href]');
    if (!anchor) return false;
    const href = anchor.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href)) return false;
    event.preventDefault();
    window.open(href, '_blank', 'noopener');
    return true;
  }

  /** Cell-level bindings for a text cell's PM keymap: the same Shift-Enter/
   *  Mod-Shift-Enter/Backspace/Escape/arrow-flow parity every other cell
   *  kind gets from cellKeymap. Mod-Enter (run) is deliberately absent —
   *  text cells don't run, so it falls through as a no-op, same as today. */
  private textCellKeymap(v: CellView): Record<string, PMCommand> {
    return {
      'Shift-Enter': () => {
        this.focusAfter(v, true);
        return true;
      },
      'Mod-Shift-Enter': () => {
        this.insertAfter(v, 'program');
        return true;
      },
      'Backspace': () => this.backspaceOnEmpty(v),
      'Escape': () => {
        this.arm(v);
        return true;
      },
      'ArrowUp': (state, _dispatch, pv) => {
        if (!state.selection.empty || !pv?.endOfTextblock('up')) return false;
        return this.moveToPrevEnd(v);
      },
      'ArrowDown': (state, _dispatch, pv) => {
        if (!state.selection.empty || !pv?.endOfTextblock('down')) return false;
        return this.moveToNextStart(v);
      },
    };
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

  /** This keymap only ever rides a CM editor (program/scratch/the source
   *  pseudo-cell): a kind switch that crosses the text/code line rebuilds
   *  the editor rather than reusing it (convertKind), so `v.cell.kind` is
   *  never 'text' while these closures fire. */
  private cellKeymap(v: CellView) {
    return keymap.of([
      { key: 'Mod-Enter', run: () => (void this.runCell(v), true) },
      { key: 'Shift-Enter', run: () => (this.runAndAdvance(v), true) },
      { key: 'Alt-Enter', run: () => (this.runAndInsertBelow(v), true) },
      { key: 'Mod-Shift-Enter', run: () => (this.insertAfter(v, 'program'), true) },
      { key: 'Backspace', run: () => this.backspaceOnEmpty(v) },
      { key: 'Escape', run: () => (this.arm(v), true) },
      {
        key: 'ArrowUp',
        run: (cm) => {
          const sel = cm.state.selection.main;
          if (!sel.empty || cm.state.doc.lineAt(sel.head).number !== 1) return false;
          return this.moveToPrevEnd(v);
        },
      },
      {
        key: 'ArrowDown',
        run: (cm) => {
          const sel = cm.state.selection.main;
          if (!sel.empty || cm.state.doc.lineAt(sel.head).number !== cm.state.doc.lines) return false;
          return this.moveToNextStart(v);
        },
      },
    ]);
  }

  /** Whether a cell holds no content: the empty CM doc, or PM's schema
   *  default (one paragraph, no content). */
  private isCellEmpty(v: CellView): boolean {
    if (v.prose) return isEmptyProseDoc(v.prose.state.doc);
    return v.editor ? v.editor.state.doc.length === 0 : false;
  }

  /** Destroy whichever editor (CM or PM) a cell holds. */
  private destroyEditors(v: CellView) {
    v.editor?.destroy();
    v.prose?.destroy();
  }

  /** Backspace in an empty cell deletes it (Jupyter's affordance) and
   *  moves focus up; the deletion is restorable via onCellDeleted. */
  private backspaceOnEmpty(v: CellView): boolean {
    if (!this.isCellEmpty(v)) return false;
    if (v.isPreamble) {
      this.doc.preamble = [];
      this.destroyEditors(v);
      v.root.remove();
      this.preambleView = null;
      if (this.views.length === 0) this.insertAtEnd('program');
      else this.focusCell(this.views[0]);
      this.onChange();
      return true;
    }
    if (this.views.length > 1) {
      const prev = this.views[this.views.indexOf(v) - 1] ?? this.views[1];
      this.remove(v);
      this.focusCell(prev);
      return true;
    }
    return false;
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

  /** Splice a cell into the document, views, and DOM at index i — the one
   *  sequence insertAt and delete-restore share, so they cannot drift. */
  private spliceIn(i: number, cell: Cell) {
    this.doc.cells.splice(i, 0, cell);
    this.syncView();
    const view = this.buildView(cell);
    this.views.splice(i, 0, view);
    if (i + 1 < this.views.length) this.views[i + 1].root.before(view.root);
    else this.endZone.before(view.root);
    if (cell.kind === 'program') {
      view.stale = true;
      this.refreshRunControl(view);
    }
    this.focusCell(view);
    this.onChange();
  }

  private insertAt(i: number, kind: NewCellKind) {
    this.ensureSeparator(this.views[i - 1]);
    // First cell after a preamble: the preamble supplies the separator.
    if (i === 0 && this.preambleView) {
      const p = this.doc.preamble;
      if (p[p.length - 1]?.trim() !== '') p.push('');
    }
    this.spliceIn(i, this.newCell(kind));
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
    this.syncView();
    this.views.splice(i, 1);
    this.destroyEditors(v);
    v.root.remove();
    this.markStaleFromIndex(i);
    this.onChange();
    if (this.views.length === 0) this.insertAtEnd('program');
    this.onUndoable?.(
      () => this.spliceIn(Math.min(i, this.views.length), cell),
      'Cell deleted — ⌘Z restores it',
    );
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
        this.refreshRunControl(view);
      }
    }
  }

  get staleCount(): number {
    return this.views.filter((v) => v.stale).length;
  }

  private refreshRunControl(v: CellView) {
    // The control itself is line 1's gutter marker; its glyph and color
    // follow these classes in CSS.
    v.row.classList.toggle('stale', v.stale);
    v.row.classList.toggle('running', v.running);
    v.row.classList.toggle('working', v.working);
  }
}
