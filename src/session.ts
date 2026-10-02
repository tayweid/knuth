// The session (docs/SESSION.md): one data structure, the receipt
// (receipts.ts), under three surfaces.
//
//   The receipt card. A run's receipt appears beside the cell that ran, in
//   the frame's dark glass, and stays while you look; keep typing, press
//   Esc, click elsewhere, or let it be for six seconds, and it flies up
//   along a curve into the session pill, whose names update as it lands
//   (new names blue). A click on it, `p` (when p would not type) or its pin
//   keeps it in place. It stands in the room's margin and never over the
//   column: its width follows the margin, and a margin too narrow slides
//   the column left for the card's stay.
//
//   The chip. Once a receipt has flown, a small chip stays at the cell's
//   right corner (the ledger's folded tab): a glyph for what the run made
//   (a figure, a table, names) and a count. Hover opens the receipt again,
//   a click holds it, a click elsewhere or Esc puts it away. Amber when the
//   cell is stale, faded after a restart. It never takes the column's width.
//
//   The Session card. The pill at the bar's right end holds the kernel's
//   status and the session's names in cell order; a click drops the card
//   from it (Session, Data, Figures). A click elsewhere or Esc closes it;
//   the pin docks it beside the column, on the page, in its own look. The
//   column slides left for it by only what the card lacks (peek-v2's
//   board), once, on the pin, never on a run.
//
// Three modes, a segmented control in the card's header: Peek (the card
// and the flight), Silent (no card, no motion: the chip and the pill update
// quietly), Pinned (the card docked; a run's receipt lands in its top band,
// and a chip's hover or click shows its cell's receipt there).

import type { Kernel, NamespaceVar, TableWindow } from './kernel/kernel.ts';
import type { DocumentView, RunInfo } from './document-view.ts';
import { icon } from './icons.ts';
import { clearSafeSvgImages, createSafeSvgImage } from './safe-svg.ts';
import { Viewer, isTabular } from './viewers.ts';
import {
  chipCount,
  chipKind,
  folderLine,
  inCellOrder,
  kindGlyph,
  overlay,
  receiptFromRun,
  settle,
  summary,
  took,
  typeLabel,
  type Receipt,
  type ReceiptRow,
} from './receipts.ts';

/** How a run's receipt shows when the card is not docked. */
export type Mode = 'peek' | 'silent';
type Tab = 'session' | 'data' | 'figures';
/** fresh: a run's, about to fly; hover: a chip's, read-only; held: kept in
 *  place (a click, p, its pin, or a chip's click) until it is put away. */
type CardKind = 'fresh' | 'hover' | 'held';
type FigureRef = { name: string } | { cell: string };

/** How long a fresh receipt stays when nothing else puts it away. */
export const DWELL_MS = 6000;
/** After the pointer leaves a fresh receipt it was resting on. */
const DWELL_AFTER_LOOK_MS = 2000;
/** The flight up into the pill. */
export const FLY_MS = 460;
/** The column's slide, on the pin or for a receipt (peek-v2's 0.36 s). */
export const SLIDE_MS = 360;
/** The chips' lane beside the column (6 + the chip + 6). */
const CHIP_LANE = 46;
/** The column (#sheet's 52rem), and the floor it narrows to while the
 *  Session card is docked. */
const COLUMN = 832;
const COLUMN_FLOOR = 640;
/** The docked card: clamp(320, what is beside the column, 380) wide, 10 px
 *  in from the room's right edge. */
const BOARD_MIN = 320;
const BOARD_MAX = 380;
const BOARD_GAP = 10;
/** The receipt card: 8 px in from the room's right edge; a run's card 6 px
 *  from the column (over the chips' lane: its own chip is hidden while it
 *  is up), a chip's past the lane; at most 300 wide, slim under 270 (short
 *  values only), 200 before the column slides for it, 160 at the least
 *  once the column has slid all the way (186 on the default 1100 px
 *  window). */
const CARD_GAP = 8;
const CARD_TIE = 6;
const CARD_MAX = 300;
const CARD_SLIM = 270;
const CARD_MIN = 200;
const CARD_FLOOR = 160;
/** A value whose preview says it in this many characters shows in a slim
 *  card in place of its type ("n 1200", not "n int"). */
const SHORT_PREVIEW = 16;
/** A table this small shows whole in the Session tab's band. */
const MINI_ROWS = 6;
const MINI_COLS = 6;
const MODE_KEY = 'knuth-receipts';
const PINNED_KEY = 'knuth-session-pinned';

export interface SessionHooks {
  /** The kernel is connected and past ready. */
  ready(): boolean;
  /** The pill's click while the kernel is not ready. */
  showOnboarding(): void;
  /** values.json and figs/ have a folder to go to. */
  hasFolder(): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function glyph(name: string): HTMLElement {
  const holder = el('i', 'g');
  holder.innerHTML = icon(name);
  return holder;
}

/** The white print the ledger drew for "this cell drew": a figure's chip. */
function printMark(): HTMLElement {
  const mark = el('i', 'pm');
  mark.innerHTML = '<svg viewBox="0 0 11 8" aria-hidden="true"><polyline points="2 6 4.5 3.5 6.5 5 9 2"/></svg>';
  return mark;
}

function isTextEntry(target: Element | null): boolean {
  return !!target && (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** A value its preview says in a few characters: a number, a short string,
 *  a short list. */
function isShort(v: NamespaceVar): boolean {
  return !isTabular(v) && !v.figure && v.preview.length <= SHORT_PREVIEW && !v.preview.includes('\n');
}

function readStore(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

function writeStore(store: () => Storage, key: string, value: string) {
  try {
    store().setItem(key, value);
  } catch {
    // A store that refuses (private mode) only costs the memory.
  }
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** The room as the session lays it out: #layout's box in the viewport, its
 *  sideways scroll, and #doc's padding and scrollbar. Widths are in
 *  #layout's own coordinates, where the doc starts at 0. */
interface Frame {
  box: DOMRect;
  scroll: number;
  padL: number;
  padR: number;
  sb: number;
  /** The doc's width before a docked card's floor: the room's, or main's
   *  640 px floor's when the window is under it. */
  width: number;
}

/** Where the column stands in a doc `width` wide — #sheet's CSS rule, worked
 *  out here so a card can be placed where the column is going rather than
 *  where it is mid-slide. `need`: what the docked card needs beside it,
 *  which slides the column left and then narrows it to the floor; `lean`:
 *  what a receipt card needs, which only slides it. */
function columnAt(f: Frame, width: number, need: number, lean: number) {
  const content = width - f.padL - f.padR - f.sb;
  const col = Math.min(content, Math.max(Math.min(COLUMN_FLOOR, content), Math.min(COLUMN, content - need)));
  const margin = Math.max(0, Math.min((content - COLUMN) / 2, content - COLUMN - Math.max(need, lean)));
  return { content, col, margin, right: f.padL + margin + col };
}

/** The docked card (peek-v2's board): clamp(320, what is beside the column
 *  at the room's left, 380) wide, past the chips' lane, 10 px in from the
 *  room's right edge. `need` is what the column gives it; `floor`, the
 *  doc's width once the column is at its floor, under which the room
 *  scrolls sideways rather than the card lie over the column. */
function boardAt(f: Frame) {
  const content = f.width - f.padL - f.padR - f.sb;
  const free = f.width - BOARD_GAP - f.padL - Math.min(COLUMN, content) - CHIP_LANE;
  const width = Math.round(Math.max(BOARD_MIN, Math.min(free, BOARD_MAX)));
  const need = CHIP_LANE + width + BOARD_GAP - f.padR - f.sb;
  const floor = f.padL + COLUMN_FLOOR + CHIP_LANE + width + BOARD_GAP;
  const column = columnAt(f, Math.max(f.width, floor), need, 0);
  return { width, need, floor: floor > f.width ? floor : 0, left: column.right + CHIP_LANE };
}

/** A small table, whole: a Series across (its index over its values), a
 *  frame down (peek-v2's mini tables). */
function miniTable(win: TableWindow, across: boolean): HTMLElement {
  const wrap = el('div', 'mt-wrap');
  const table = el('table', `mt ${across ? 'h' : 'v'}`);
  const columns = win.columns ?? [];
  const index = win.index ?? [];
  const rows = win.rows ?? [];
  if (across) {
    const top = el('tr');
    top.append(el('th'), ...index.map((i) => el('td', '', i)));
    const values = el('tr');
    values.append(el('th', '', columns[0] === '0' ? '' : columns[0] ?? ''), ...rows.map((r) => el('td', '', r[0] ?? '')));
    table.append(top, values);
  } else {
    const head = el('thead');
    const top = el('tr');
    top.append(el('th'), ...columns.map((c) => el('td', '', c)));
    head.append(top);
    const body = el('tbody');
    rows.forEach((r, i) => {
      const tr = el('tr');
      tr.append(el('th', '', index[i] ?? ''), ...r.map((x) => el('td', '', x)));
      body.append(tr);
    });
    table.append(head, body);
  }
  wrap.append(table);
  return wrap;
}

export class Session {
  /** The session as the page last knew it, by name. */
  private snapshot = new Map<string, NamespaceVar>();
  private receipts = new Map<string, Receipt>();
  /** Which cell made each name (its latest receipt holds it). */
  private owner = new Map<string, string>();
  /** When each name was last bound, as a running count: the pill's least
   *  recently bound names give way first. */
  private boundAt = new Map<string, number>();
  private bindings = 0;
  /** The cell whose receipt is the last run's. */
  private last: string | null = null;
  /** New names nobody has looked at yet: blue in the pill. */
  private unseen = new Set<string>();
  /** New names a fresh receipt still holds, until it lands in the pill. */
  private pending = new Set<string>();
  /** A restart emptied the session: the pill says "fresh session". */
  private fresh = false;
  private mode: Mode;
  private docked: boolean;
  private floating = false;
  private tab: Tab = 'session';
  private card: { id: string; kind: CardKind } | null = null;
  /** Docked: the cell whose receipt the band shows in place of the last
   *  run's (a chip hovered, or clicked: held), and the tab to go back to
   *  when a hover ends. */
  private band: { id: string; held: boolean; back?: Tab } | null = null;
  private dwell = 0;
  private hoverTimer = 0;
  /** Ends the flight under way at once (a new card needs the element). */
  private flightEnd: (() => void) | null = null;
  /** The last time the person carried on (typed, clicked, pressed Esc). */
  private carriedAt = 0;
  private landedAt = 0;
  private dataName: string | null = null;
  private figure: FigureRef | null = null;
  private figHeld = false;
  private figWaiting: FigureRef | null = null;
  /** The band's small tables, per receipt and name, as the kernel paged
   *  them ('wait' while asked). */
  private minis = new WeakMap<Receipt, Map<string, TableWindow | null | 'wait'>>();
  /** What #sheet's CSS is told: the docked card's need, a receipt's lean,
   *  and the doc's floor while docked. */
  private column = { need: 0, lean: 0, floor: 0 };
  private slideTimer = 0;
  private rideTimer = 0;
  private returnTimer = 0;

  private readonly pill: HTMLButtonElement;
  private readonly names: HTMLElement;
  private readonly receiptEl: HTMLElement;
  private readonly cardEl: HTMLElement;
  private readonly panes: Record<Tab, HTMLElement>;
  private readonly data: Viewer;
  private readonly figs: Viewer;
  private readonly room: HTMLElement;
  private readonly doc: HTMLElement;
  private readonly sheet: HTMLElement;

  constructor(
    private kernel: Kernel,
    private docView: DocumentView,
    private toggle: HTMLButtonElement,
    private hooks: SessionHooks,
  ) {
    this.room = document.getElementById('layout')!;
    this.doc = document.getElementById('doc')!;
    this.sheet = document.getElementById('sheet')!;
    this.mode = readStore(() => localStorage, MODE_KEY) === 'silent' ? 'silent' : 'peek';
    // Pinned is per window (a reload keeps it); a new window starts as the
    // last one was left.
    const pinned = readStore(() => sessionStorage, PINNED_KEY) ?? readStore(() => localStorage, PINNED_KEY);
    this.docked = pinned === '1';

    // The pill: the kernel's status (#kernel-status, untouched: the shell's
    // smoke reads its words), a hairline, the session's mark and its names.
    this.pill = document.getElementById('session-pill') as HTMLButtonElement;
    this.names = this.pill.querySelector<HTMLElement>('.sp-names')!;
    this.pill.addEventListener('mousedown', (e) => e.preventDefault());
    this.pill.addEventListener('click', () => {
      if (!this.hooks.ready()) this.hooks.showOnboarding();
      else this.toggleCard();
    });
    this.toggle.addEventListener('click', () => this.toggleCard());

    this.receiptEl = el('div');
    this.receiptEl.id = 'receipt';
    this.receiptEl.hidden = true;
    this.receiptEl.setAttribute('role', 'dialog');
    this.receiptEl.setAttribute('aria-label', 'What this run did');
    document.body.append(this.receiptEl);
    this.receiptEl.addEventListener('mouseenter', () => this.lookAtCard(true));
    this.receiptEl.addEventListener('mouseleave', () => this.lookAtCard(false));
    this.receiptEl.addEventListener('mousedown', (e) => {
      const target = e.target as Element;
      // The card keeps no focus.
      if (!target.closest('button')) e.preventDefault();
      // A click anywhere on a run's or a chip's card keeps it, but on what
      // acts on its own click (its pin and ✕, a table or a figure to open).
      if (target.closest('button, tr.viewable, .r-fig')) return;
      if (this.card?.kind === 'fresh' || this.card?.kind === 'hover') this.holdCard();
    });

    this.cardEl = el('section');
    this.cardEl.id = 'session';
    this.cardEl.hidden = true;
    this.cardEl.setAttribute('aria-label', 'Session');
    this.cardEl.innerHTML = `
      <div class="s-head">
        <div class="s-tabs" role="tablist">
          <button type="button" role="tab" data-tab="session">Session</button>
          <button type="button" role="tab" data-tab="data">Data</button>
          <button type="button" role="tab" data-tab="figures">Figures</button>
        </div>
        <div class="s-modes" role="radiogroup" aria-label="When a cell runs">
          <button type="button" role="radio" data-mode="peek" title="Peek: the run's receipt beside the cell, then up into the pill">Peek</button>
          <button type="button" role="radio" data-mode="silent" title="Silent: no card, no motion — the chip and the pill update quietly">Silent</button>
          <button type="button" role="radio" data-mode="pinned" title="Pinned: the session beside the column, the last run on top">${icon('pin')}<span>Pinned</span></button>
        </div>
        <button type="button" class="s-close" title="Close (Esc)" aria-label="Close">✕</button>
      </div>
      <div class="s-body">
        <div class="s-pane" data-pane="session" role="tabpanel"></div>
        <div class="s-pane" data-pane="data" role="tabpanel"><div class="s-pick"></div><div class="s-view"></div><div class="s-note"></div></div>
        <div class="s-pane" data-pane="figures" role="tabpanel"><div class="s-pick"></div><div class="s-view"></div><div class="s-note"></div></div>
      </div>`;
    document.body.append(this.cardEl);
    this.panes = {
      session: this.cardEl.querySelector<HTMLElement>('[data-pane="session"]')!,
      data: this.cardEl.querySelector<HTMLElement>('[data-pane="data"]')!,
      figures: this.cardEl.querySelector<HTMLElement>('[data-pane="figures"]')!,
    };
    this.data = new Viewer(this.panes.data.querySelector<HTMLElement>('.s-view')!, kernel, () => {
      this.dataName = null;
      this.paintCard();
    });
    this.figs = new Viewer(this.panes.figures.querySelector<HTMLElement>('.s-view')!, kernel, () => {
      this.figure = null;
      this.figHeld = false;
      this.paintCard();
    });
    for (const button of this.cardEl.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      button.addEventListener('click', () => this.showTab(button.dataset.tab as Tab));
    }
    for (const button of this.cardEl.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      button.addEventListener('click', () => this.setMode(button.dataset.mode as Mode | 'pinned'));
    }
    this.cardEl.querySelector('.s-close')!.addEventListener('click', () => this.closeCard());

    this.listen();
    this.paintPill();
    this.paintToggle();
    if (this.docked) this.showSessionCard();
  }

  // ---------- what the document view and main tell the session ----------

  /** A run finished: its receipt, and where it shows. */
  ran(run: RunInfo): void {
    const before = new Map(this.snapshot);
    const receipt = receiptFromRun(run, before);
    this.snapshot = overlay(before, receipt);
    this.fresh = false;
    this.receipts.set(run.id, receipt);
    this.last = run.id;
    // The source view's whole-file editor is no cell: what it binds is the
    // session's, unowned, until a cell binds it.
    if (run.id !== 'source') for (const row of receipt.rows) this.owner.set(row.name, run.id);
    for (const row of receipt.rows) this.boundAt.set(row.name, ++this.bindings);
    // A run on its own replaces the last run's blue; a batch adds up.
    if (!run.batch) this.unseen.clear();
    const added = receipt.rows.filter((row) => row.mark === '+').map((row) => row.name);
    for (const name of added) this.unseen.add(name);
    const peek = !this.docked && this.mode === 'peek' && !run.batch && run.ok;
    const late = peek && !this.hasContent(receipt);
    if (this.band) {
      const was = this.band.id;
      this.band = null;
      this.paintChip(was);
    }
    if (peek && !late) {
      this.pending = new Set(added);
      this.showCard(run.id, 'fresh');
    } else {
      this.paintChip(run.id);
      if (this.docked) this.landedAt = performance.now();
    }
    if (receipt.figures.length || receipt.named.length) this.follow(run.id, receipt);
    this.paintPill();
    this.paintCard();
    const endedAt = performance.now();
    void this.kernel.namespace().then((vars) => this.settled(receipt, before, vars, late, endedAt));
  }

  /** A run is starting: a fresh receipt still up flies home first. */
  runStarting(_id: string): void {
    if (this.card?.kind === 'fresh') this.tuck();
    else if (this.card?.kind === 'hover') this.hideCard();
  }

  /** The kernel's state moved (main paints #kernel-status): the names show
   *  only beside a ready kernel. */
  statusChanged(): void {
    this.paintPill();
  }

  /** Read the namespace with no run to credit (a kernel ready, a resumed
   *  session, a package installed): names no cell is known to have bound
   *  join the pill and the Session tab unowned. */
  async refresh(): Promise<void> {
    const vars = await this.kernel.namespace();
    if (!this.hooks.ready()) return;
    this.take(vars);
    this.paintPill();
    this.paintCard();
    void this.data.refresh(vars);
    void this.figs.refresh(vars);
  }

  /** A fresh process: the names are gone, the chips fade until their cells
   *  run again, the pill says so. */
  restarted(): void {
    for (const receipt of this.receipts.values()) receipt.past = true;
    this.snapshot.clear();
    this.owner.clear();
    this.boundAt.clear();
    this.unseen.clear();
    this.pending.clear();
    this.fresh = true;
    this.band = null;
    this.hideCard();
    this.data.close();
    this.figs.close();
    this.dataName = null;
    this.figure = null;
    this.figWaiting = null;
    this.paintChips();
    this.paintPill();
    this.paintCard();
  }

  /** A different document, or the same one fresh from disk: no receipt
   *  finds its cell again (every Cell is new). The names stay, unowned. */
  documentChanged(): void {
    this.receipts.clear();
    this.owner.clear();
    this.last = null;
    this.fresh = false;
    this.band = null;
    this.hideCard();
    this.paintPill();
    this.paintCard();
  }

  /** A cell's row was built: hang its chip. */
  decorate(id: string, row: HTMLElement): void {
    this.paintChip(id, row);
  }

  // ---------- the column, the receipt card and the Session card, laid out ----------

  private frame(): Frame {
    const box = this.room.getBoundingClientRect();
    const style = getComputedStyle(this.doc);
    // main's floor: a 640 px window, less the rail and the frame's edge.
    const floor = 640 - box.left - (window.innerWidth - box.right);
    return {
      box,
      scroll: this.room.scrollLeft,
      padL: parseFloat(style.paddingLeft) || 0,
      padR: parseFloat(style.paddingRight) || 0,
      sb: Math.max(0, this.doc.offsetWidth - this.doc.clientWidth),
      width: Math.max(box.width, floor),
    };
  }

  /** Everything the session lays over the room: where the column stands
   *  (#sheet's --need and --lean, #doc's --board-floor), the receipt card
   *  and the Session card. `slide`: a pin, or a receipt coming or going,
   *  which the column follows over SLIDE_MS; a resize or a scroll moves it
   *  at once. A run never changes what the docked card needs. */
  private layout(slide = false) {
    const inCells = !document.body.dataset.view;
    if (this.card) {
      const row = this.docView.cellRow(this.card.id);
      if (!row || !row.isConnected || !inCells || this.docked) this.dropCard();
    }
    clearTimeout(this.returnTimer);
    const f = this.frame();
    const board = this.docked && inCells ? boardAt(f) : null;
    const fit = this.card ? this.fitCard(f, this.card.kind) : null;
    const from = fit && slide ? this.sheet.getBoundingClientRect().right : null;
    const sliding = this.setColumn(board?.need ?? 0, fit?.lean ?? 0, board?.floor ?? 0, slide);
    if (this.card && fit) this.placeCard(f, fit, sliding ? from : null);
    this.placeSessionCard(f, board);
  }

  /** Tell #sheet where to stand; true when it will slide there. */
  private setColumn(need: number, lean: number, floor: number, slide: boolean): boolean {
    const now = this.column;
    const moved = Math.abs(now.need - need) > 0.5 || Math.abs(now.lean - lean) > 0.5;
    const sliding = moved && slide && !reducedMotion();
    if (moved) {
      if (sliding) {
        this.sheet.classList.add('slide');
        clearTimeout(this.slideTimer);
        this.slideTimer = window.setTimeout(() => this.sheet.classList.remove('slide'), SLIDE_MS + 60);
      }
      this.sheet.style.setProperty('--need', `${need}px`);
      this.sheet.style.setProperty('--lean', `${lean}px`);
    }
    if (Math.abs(now.floor - floor) > 0.5) this.doc.style.setProperty('--board-floor', `${floor}px`);
    this.column = { need, lean, floor };
    return sliding;
  }

  /** The receipt card beside the column, in the viewport: as wide as the
   *  margin gives, up to 300. A margin under 200 slides the column left by
   *  the difference (as far as it is centred) for the card's stay; still
   *  short once it has slid all the way, the card takes what there is down
   *  to 160. Only a window too narrow even for that (under about 1075 px)
   *  lays it, 160 wide, at the room's right edge over the column's. */
  private fitCard(f: Frame, kind: CardKind): { left: number; width: number; lean: number; tie: number | null } {
    const docLeft = f.box.left - f.scroll;
    const edge = f.box.right - CARD_GAP;
    const at = (tie: number, lean: number) => {
      const left = docLeft + columnAt(f, f.width, 0, lean).right + tie;
      return { left, width: Math.min(CARD_MAX, edge - left), lean, tie: tie as number | null };
    };
    for (const tie of kind === 'fresh' ? [CARD_TIE] : [CHIP_LANE, CARD_TIE]) {
      const fit = at(tie, 0);
      if (fit.width >= CARD_MIN) return fit;
    }
    const slid = at(CARD_TIE, CARD_TIE + CARD_MIN + CARD_GAP - f.padR - f.sb);
    if (slid.width >= CARD_FLOOR) return slid;
    const width = Math.min(CARD_FLOOR, f.box.width - 2 * CARD_GAP);
    return { left: f.box.right - CARD_GAP - width, width, lean: slid.lean, tie: null };
  }

  /** Its top on the cell's first line, kept inside the room. While the
   *  column slides for it (`from`: the column's right edge as the slide
   *  starts), it rides along beside it, on the same curve, so it is never
   *  over the column even mid-slide. */
  private placeCard(f: Frame, fit: { left: number; width: number; tie: number | null }, from: number | null) {
    if (!this.card) return;
    const row = this.docView.cellRow(this.card.id)!;
    const anchor = (row.querySelector('.cm-editor') ?? row).getBoundingClientRect();
    const style = this.receiptEl.style;
    style.width = `${fit.width}px`;
    this.receiptEl.classList.toggle('slim', fit.width < CARD_SLIM);
    const height = this.receiptEl.offsetHeight;
    if (from !== null && fit.tie !== null) {
      this.receiptEl.classList.remove('riding');
      style.left = `${from + fit.tie}px`;
      void this.receiptEl.offsetWidth;
      this.receiptEl.classList.add('riding');
      clearTimeout(this.rideTimer);
      this.rideTimer = window.setTimeout(() => this.receiptEl.classList.remove('riding'), SLIDE_MS + 60);
    }
    style.left = `${fit.left}px`;
    style.top = `${Math.max(f.box.top + 10, Math.min(anchor.top, f.box.bottom - height - 10))}px`;
  }

  /** Floating: from the pill, at the room's top right, over the room.
   *  Docked: on the page — inside the room, so it scrolls sideways with it
   *  below the floor — beside the column past the chips' lane. */
  private placeSessionCard(f: Frame, board: ReturnType<typeof boardAt> | null) {
    // Source and grid views hide it where it is.
    if (this.cardEl.hidden || this.away) return;
    const parent = board ? this.room : document.body;
    if (this.cardEl.parentElement !== parent) parent.append(this.cardEl);
    const style = this.cardEl.style;
    let width: number;
    if (board) {
      width = board.width;
      style.left = `${board.left}px`;
      style.top = '12px';
      style.maxHeight = `${Math.max(160, f.box.height - 24)}px`;
    } else {
      width = Math.min(380, f.box.width - 20);
      style.left = `${f.box.right - 10 - width}px`;
      style.top = `${f.box.top + 10}px`;
      style.maxHeight = `${Math.max(160, f.box.height - 20)}px`;
    }
    style.width = `${width}px`;
    this.cardEl.classList.toggle('docked', !!board);
    this.cardEl.classList.toggle('floating', !board);
    this.cardEl.classList.toggle('narrow', width < 300);
    // The modes on one line with the tabs: the pin alone under 370.
    this.cardEl.classList.toggle('tight', width < 370);
  }

  // ---------- the receipt card ----------

  private hasContent(receipt: Receipt): boolean {
    return receipt.rows.length > 0 || receipt.figures.length > 0;
  }

  /** The snapshot after a run is in: what the AST missed joins the
   *  receipt. `late`: the run's own report had nothing to show, so its card
   *  waits for this. */
  private settled(receipt: Receipt, before: Map<string, NamespaceVar>, vars: NamespaceVar[], late: boolean, endedAt: number) {
    if (!this.hooks.ready()) return;
    const known = new Set(receipt.rows.map((row) => row.name));
    settle(receipt, before, vars);
    const found = receipt.rows.filter((row) => !known.has(row.name));
    for (const row of found) {
      if (receipt.id !== 'source') this.owner.set(row.name, receipt.id);
      this.boundAt.set(row.name, ++this.bindings);
      if (row.mark === '+') {
        this.unseen.add(row.name);
        if (this.card?.id === receipt.id && this.card.kind === 'fresh') this.pending.add(row.name);
      }
    }
    this.take(vars);
    const current = this.receipts.get(receipt.id) === receipt;
    // A run whose news only the snapshot saw (a change in place) still
    // gets its card, unless the person has carried on since.
    if (current && late && !this.card && found.length && this.last === receipt.id && this.carriedAt < endedAt && !this.docked && this.mode === 'peek') {
      this.pending = new Set(found.filter((row) => row.mark === '+').map((row) => row.name));
      this.showCard(receipt.id, 'fresh');
    } else if (this.card?.id === receipt.id) {
      this.renderReceiptCard();
      this.layout();
    } else if (current) {
      this.paintChip(receipt.id);
    }
    this.paintPill();
    this.paintCard();
    void this.data.refresh(vars);
  }

  /** The snapshot after a run or a refresh is the session now. */
  private take(vars: NamespaceVar[]) {
    this.snapshot = new Map(vars.map((v) => [v.name, v]));
    for (const name of [...this.owner.keys()]) if (!this.snapshot.has(name)) this.owner.delete(name);
    for (const name of [...this.unseen]) if (!this.snapshot.has(name)) this.unseen.delete(name);
    if (vars.length) this.fresh = false;
  }

  private showCard(id: string, kind: CardKind) {
    if (this.docked) return; // docked, a receipt shows in the band
    if (this.card?.kind === 'fresh' && this.card.id !== id) this.tuck();
    this.flightEnd?.();
    const previous = this.card?.id;
    this.card = { id, kind };
    clearTimeout(this.dwell);
    this.renderReceiptCard();
    this.receiptEl.hidden = false;
    this.receiptEl.classList.remove('show');
    this.layout(true);
    if (!this.card) return; // its cell is not on screen
    void this.receiptEl.offsetWidth;
    this.receiptEl.classList.add('show');
    if (kind === 'fresh') this.dwell = window.setTimeout(() => this.tuck(), DWELL_MS);
    if (previous && previous !== id) this.paintChip(previous);
    this.paintChip(id);
  }

  /** The receipt, in the card: a run's (fresh), a chip's (hover) or held. */
  private renderReceiptCard() {
    if (!this.card) return;
    const receipt = this.receipts.get(this.card.id);
    clearSafeSvgImages(this.receiptEl);
    if (!receipt) return;
    this.receiptEl.dataset.kind = this.card.kind;
    this.receiptEl.dataset.cell = this.card.id;
    this.receiptEl.append(this.receiptView(receipt, this.card.kind));
  }

  /** What keeps a run's card, as it can be done now: `p` only when the
   *  keystroke would not type (focus off the text), a click always. */
  private hint(): string {
    return isTextEntry(document.activeElement) ? 'type or esc ↗ · click to keep' : 'type or esc ↗ · p keeps it';
  }

  private lookAtCard(looking: boolean) {
    if (!this.card) return;
    clearTimeout(this.hoverTimer);
    if (this.card.kind === 'fresh') {
      clearTimeout(this.dwell);
      if (!looking) this.dwell = window.setTimeout(() => this.tuck(), DWELL_AFTER_LOOK_MS);
    } else if (this.card.kind === 'hover' && !looking) {
      this.hoverTimer = window.setTimeout(() => this.hideCard(), 180);
    }
  }

  /** Every way out of a fresh receipt is the same flight: home, into the
   *  pill, along a curve, shrinking, seen all the way in; the pill's names
   *  update as it arrives, the chip takes its place at the cell, and the
   *  column, if it slid for the card, slides back. */
  private tuck() {
    if (!this.card) return;
    const { id, kind } = this.card;
    if (kind !== 'fresh') {
      this.hideCard();
      return;
    }
    this.card = null;
    clearTimeout(this.dwell);
    const landing = [...this.pending];
    let landed = false;
    const land = () => {
      if (landed) return;
      landed = true;
      this.pending.clear();
      this.paintPill(landing.length ? landing : undefined);
      this.paintChip(id);
    };
    const card = this.receiptEl;
    if (reducedMotion() || !card.animate || card.hidden) {
      this.hideCard(true);
      land();
      return;
    }
    card.classList.remove('riding');
    const from = card.getBoundingClientRect();
    // The column, if it slid for the card, goes back once the card has
    // lifted clear of it.
    if (this.column.lean > 0) {
      clearTimeout(this.returnTimer);
      this.returnTimer = window.setTimeout(() => this.layout(true), FLY_MS * 0.3);
    }
    const target = (this.names.getClientRects().length && this.names.getBoundingClientRect().width > 0 ? this.names : this.pill).getBoundingClientRect();
    const dx = target.left - from.left;
    const dy = target.top - from.top;
    const sx = Math.max(0.08, Math.min(1, target.width / from.width));
    const sy = Math.max(0.05, Math.min(1, target.height / from.height));
    // A quadratic curve that lifts first and then swings across into the
    // pill: the control point sits most of the way up, a little across.
    // Opaque for most of the way and still showing as it enters the pill;
    // gone only on arriving.
    const cx = dx * 0.18;
    const cy = dy * 0.92;
    const frames: Keyframe[] = [];
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = 2 * (1 - t) * t * cx + t * t * dx;
      const y = 2 * (1 - t) * t * cy + t * t * dy;
      const grow = t ** 1.3;
      const opacity = t <= 0.85 ? 1 : t <= 0.93 ? 1 - ((t - 0.85) / 0.08) * 0.15 : 0.85 * (1 - (t - 0.93) / 0.07);
      frames.push({
        transform: `translate(${x}px, ${y}px) scale(${1 + (sx - 1) * grow}, ${1 + (sy - 1) * grow})`,
        opacity,
        offset: t,
      });
    }
    card.classList.add('flying');
    document.body.classList.add('session-flying');
    const flight = card.animate(frames, { duration: FLY_MS, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' });
    // The names light as the card reaches the pill, still showing (seven
    // eighths of the way, at 60 % of the time on this easing); it fades
    // into them for the rest.
    const landTimer = window.setTimeout(land, FLY_MS * 0.6);
    const done = () => {
      if (this.flightEnd !== done) return;
      this.flightEnd = null;
      clearTimeout(landTimer);
      card.classList.remove('flying');
      document.body.classList.remove('session-flying');
      land();
      flight.cancel();
      if (!this.card) this.hideCard(true);
    };
    this.flightEnd = done;
    flight.onfinish = done;
    flight.oncancel = done;
  }

  /** A click on it, p, or its pin: the receipt stays where it is until
   *  closed. */
  private holdCard() {
    if (!this.card || this.card.kind === 'held') return;
    const wasFresh = this.card.kind === 'fresh';
    this.card.kind = 'held';
    clearTimeout(this.dwell);
    clearTimeout(this.hoverTimer);
    if (wasFresh) {
      const landing = [...this.pending];
      this.pending.clear();
      this.paintPill(landing.length ? landing : undefined);
    }
    this.renderReceiptCard();
    this.layout();
    if (this.card) this.paintChip(this.card.id);
  }

  /** The card's state, put away (no layout): the chip shows again. */
  private dropCard(quiet = false) {
    const id = this.card?.id ?? this.receiptEl.dataset.cell;
    if (this.card?.kind === 'fresh' && this.pending.size) {
      const landing = [...this.pending];
      this.pending.clear();
      this.paintPill(landing);
    }
    this.card = null;
    clearTimeout(this.dwell);
    clearTimeout(this.hoverTimer);
    this.receiptEl.hidden = true;
    this.receiptEl.classList.remove('show', 'slim');
    clearSafeSvgImages(this.receiptEl);
    delete this.receiptEl.dataset.cell;
    if (id && !quiet) this.paintChip(id);
  }

  /** Put the card away without the flight (a chip's, a held one, a cell
   *  gone); the column, if it slid for the card, slides back. */
  private hideCard(quiet = false) {
    const had = !!this.card || this.column.lean > 0;
    this.dropCard(quiet);
    if (had) this.layout(true);
  }

  // ---------- the chips ----------

  private paintChips() {
    for (const id of this.receipts.keys()) this.paintChip(id);
  }

  /** The chip at a cell's right corner: what its last run made, and how
   *  many. Hidden while that run's fresh receipt is still up. */
  private paintChip(id: string, row: HTMLElement | null = this.docView.cellRow(id)) {
    if (!row) return;
    let chip = row.querySelector<HTMLButtonElement>(':scope > .rchip');
    const receipt = this.receipts.get(id);
    const kind = receipt ? chipKind(receipt) : null;
    if (!receipt || !kind || (this.card?.id === id && this.card.kind === 'fresh')) {
      chip?.remove();
      return;
    }
    if (!chip) {
      chip = el('button', 'rchip');
      chip.type = 'button';
      chip.dataset.cell = id;
      chip.addEventListener('mousedown', (e) => e.preventDefault());
      chip.addEventListener('mouseenter', () => {
        clearTimeout(this.hoverTimer);
        if (this.docked) {
          if (this.band?.id !== id) this.hoverTimer = window.setTimeout(() => this.showBand(id, false), 120);
          return;
        }
        if (this.card?.id === id) return;
        if (this.card?.kind === 'held') return;
        this.hoverTimer = window.setTimeout(() => {
          if (this.card?.kind === 'fresh') this.tuck();
          this.showCard(id, 'hover');
        }, 120);
      });
      chip.addEventListener('mouseleave', () => {
        clearTimeout(this.hoverTimer);
        if (this.docked) {
          if (this.band?.id === id && !this.band.held) this.hoverTimer = window.setTimeout(() => this.clearBand(), 180);
          return;
        }
        if (this.card?.id === id && this.card.kind === 'hover') {
          this.hoverTimer = window.setTimeout(() => this.hideCard(), 180);
        }
      });
      chip.addEventListener('click', () => {
        clearTimeout(this.hoverTimer);
        if (this.docked) {
          if (this.band?.id === id && this.band.held) this.clearBand();
          else this.showBand(id, true);
          return;
        }
        if (this.card?.id === id && this.card.kind === 'held') this.hideCard();
        else {
          if (this.card?.id !== id) this.showCard(id, 'hover');
          this.holdCard();
        }
      });
      row.append(chip);
    }
    const on = this.card?.id === id || this.band?.id === id;
    chip.className = `rchip kind-${kind}${receipt.past ? ' past' : ''}${on ? ' on' : ''}`;
    chip.replaceChildren(kind === 'figure' ? printMark() : glyph(kind === 'table' ? 'table' : 'braces'), el('span', 'n', String(chipCount(receipt))));
    const named = receipt.rows.map((r) => r.name);
    chip.title = `${receipt.past ? 'Before the restart: ' : ''}${named.length ? named.join(', ') : 'a figure'} — hover for the receipt, click to keep it`;
    chip.setAttribute('aria-label', `Receipt of the last run: ${chip.title}`);
  }

  // ---------- the band: the Session tab's top, docked ----------

  /** Docked, a chip's hover (or click: held) shows its cell's receipt in
   *  the band — "Earlier run · cell 2" — lit and in view, rather than a
   *  card over the docked one. A hover from the Data or Figures tab goes
   *  back to it when it ends. */
  private showBand(id: string, held: boolean) {
    if (!this.docked || !this.receipts.has(id)) return;
    const previous = this.band?.id;
    const back = held ? undefined : this.band?.back ?? (this.tab !== 'session' ? this.tab : undefined);
    this.band = { id, held, back };
    this.landedAt = performance.now();
    this.tab = 'session';
    this.paintCard();
    this.panes.session.scrollTop = 0;
    if (previous && previous !== id) this.paintChip(previous);
    this.paintChip(id);
  }

  /** The band shows the last run again. */
  private clearBand() {
    if (!this.band) return;
    const { id, back } = this.band;
    this.band = null;
    if (back) this.tab = back;
    this.paintCard();
    this.paintChip(id);
  }

  // ---------- the pill ----------

  private ordered(): string[] {
    return inCellOrder([...this.snapshot.keys()], this.owner, this.docView.cellIds(), this.receipts);
  }

  /** Source and grid views have no cells for the Session card to stand
   *  beside: the pill rests, and its title says why. */
  private get away(): boolean {
    return !!document.body.dataset.view;
  }

  private awayTitle(): string {
    const { view, cells } = document.body.dataset;
    return view === 'source' && cells === 'true'
      ? 'The Session card shows beside the cells: switch to cell view (⌘⇧E) to open it'
      : 'The Session card shows beside a document\'s cells, and this view has none';
  }

  /** The kernel's status, then the names in cell order (new ones blue), or
   *  "empty session" / "fresh session" in words. `landing`: the names a
   *  receipt just brought home, lit for a moment. */
  private paintPill(landing?: string[]) {
    const ready = this.hooks.ready();
    const away = this.away;
    this.pill.classList.toggle('ready', ready);
    this.pill.classList.toggle('open', this.visible && !away);
    if (ready && away) this.pill.setAttribute('aria-disabled', 'true');
    else this.pill.removeAttribute('aria-disabled');
    this.names.replaceChildren();
    if (!ready) {
      this.pill.title = 'The Python engine is not connected';
      return;
    }
    const names = this.ordered().filter((name) => !this.pending.has(name));
    if (!names.length) {
      this.names.append(el('span', 'sp-empty', this.fresh ? 'fresh session' : 'empty session'));
      this.pill.title = away ? this.awayTitle() : this.fresh ? 'A fresh session: run a cell to fill it' : 'Nothing in the session yet: run a cell';
      return;
    }
    const spans: HTMLElement[] = [];
    for (const name of names) {
      const v = this.snapshot.get(name)!;
      const span = el('span', '', name);
      span.dataset.name = name;
      if (this.unseen.has(name)) span.classList.add('new');
      if (v.scratch) span.classList.add('scratch');
      if (landing?.includes(name) && this.mode === 'peek') span.classList.add('land');
      spans.push(span);
    }
    const more = el('span', 'sp-more');
    this.names.append(...spans, more);
    // Never out of sight: what a receipt is bringing home, and the last
    // run's names.
    const keep = new Set(landing ?? []);
    const lastRun = this.last ? this.receipts.get(this.last) : undefined;
    if (lastRun && !lastRun.past) for (const row of lastRun.rows) keep.add(row.name);
    this.fitNames(spans, more, keep);
    const figures = names.filter((name) => this.snapshot.get(name)?.figure).length;
    const count = `The session: ${names.length} name${names.length === 1 ? '' : 's'}${figures ? `, ${figures} figure${figures === 1 ? '' : 's'}` : ''}`;
    this.pill.title = away ? `${count} — ${this.awayTitle()}` : `${count} — click to ${this.visible ? 'close' : 'open'} it`;
    if (landing && this.mode === 'peek') {
      this.pill.classList.remove('got');
      void this.pill.offsetWidth;
      this.pill.classList.add('got');
    }
  }

  /** Too many names for the pill: the least recently bound give way to
   *  "+N" first, and those in `keep` only when nothing else is left. Laid
   *  out once: every width read in one pass, the hiding worked out here
   *  and written at the end. */
  private fitNames(spans: HTMLElement[], more: HTMLElement, keep: Set<string>) {
    more.textContent = `+${spans.length}`;
    const room = this.names.clientWidth;
    const gap = parseFloat(getComputedStyle(this.names).columnGap) || 0;
    const widths = spans.map((span) => span.offsetWidth);
    const plus = more.offsetWidth;
    let total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, spans.length - 1);
    if (total <= room + 1) {
      more.hidden = true;
      more.textContent = '';
      return;
    }
    const name = (i: number) => spans[i].dataset.name!;
    const order = spans
      .map((_, i) => i)
      .sort((a, b) =>
        Number(keep.has(name(a))) - Number(keep.has(name(b))) ||
        (this.boundAt.get(name(a)) ?? 0) - (this.boundAt.get(name(b)) ?? 0) ||
        b - a);
    const budget = room - plus - gap;
    const hide: number[] = [];
    for (const i of order) {
      if (total <= budget + 1) break;
      hide.push(i);
      total -= widths[i] + gap;
    }
    for (const i of hide) spans[i].hidden = true;
    more.textContent = `+${hide.length}`;
  }

  // ---------- the Session card ----------

  private get visible(): boolean {
    return this.docked || this.floating;
  }

  private toggleCard() {
    if (this.away) return;
    if (this.visible) this.closeCard();
    else this.openFloating();
  }

  private openFloating() {
    if (this.away) return;
    this.floating = true;
    this.showSessionCard(true);
  }

  private showSessionCard(animate = false) {
    if (this.tab === 'session') this.unseen.clear();
    this.cardEl.hidden = false;
    this.paintCard();
    this.layout(animate);
    if (animate && !reducedMotion()) {
      this.cardEl.animate(
        [{ opacity: 0, transform: 'translateY(-6px) scale(0.97)' }, { opacity: 1, transform: 'none' }],
        { duration: 160, easing: 'cubic-bezier(.2,.7,.2,1)' },
      );
    }
    this.paintToggle();
    this.paintPill();
  }

  private closeCard() {
    if (!this.visible) return;
    if (this.docked) this.setDocked(false);
    this.floating = false;
    this.cardEl.hidden = true;
    this.layout(true);
    this.paintToggle();
    this.paintPill();
  }

  private setDocked(on: boolean) {
    this.docked = on;
    if (!on && this.band) {
      const was = this.band.id;
      this.band = null;
      this.paintChip(was);
    }
    writeStore(() => sessionStorage, PINNED_KEY, on ? '1' : '0');
    writeStore(() => localStorage, PINNED_KEY, on ? '1' : '0');
  }

  /** The header's segmented control: Peek and Silent are how a run's
   *  receipt shows (remembered); Pinned docks the card (per window). */
  private setMode(mode: Mode | 'pinned') {
    if (mode === 'pinned') {
      if (this.docked) return;
      this.hideCard();
      this.setDocked(true);
      this.floating = false;
      this.paintCard();
      this.layout(true);
      if (!reducedMotion()) {
        this.cardEl.animate(
          [{ opacity: 0, transform: 'translateY(-10px) scale(0.98)' }, { opacity: 1, transform: 'none' }],
          { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' },
        );
      }
      this.paintPill();
      return;
    }
    this.mode = mode;
    writeStore(() => localStorage, MODE_KEY, mode);
    if (this.docked) {
      this.setDocked(false);
      this.floating = true;
    }
    this.paintCard();
    this.layout(true);
  }

  private paintToggle() {
    this.toggle.setAttribute('aria-pressed', String(this.visible));
  }

  private showTab(tab: Tab) {
    this.tab = tab;
    if (this.band && !this.band.held) this.band.back = undefined;
    if (tab === 'session') this.unseen.clear();
    this.paintCard();
    this.paintPill();
    if (tab === 'figures' && this.figure) void this.renderFigure();
  }

  /** Repaint whatever the card shows. */
  private paintCard() {
    if (this.cardEl.hidden) return;
    for (const button of this.cardEl.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      const on = button.dataset.tab === this.tab;
      button.setAttribute('aria-selected', String(on));
      button.classList.toggle('on', on);
    }
    const current = this.docked ? 'pinned' : this.mode;
    for (const button of this.cardEl.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
      const on = button.dataset.mode === current;
      button.setAttribute('aria-checked', String(on));
      button.classList.toggle('on', on);
    }
    for (const [tab, pane] of Object.entries(this.panes)) pane.hidden = tab !== this.tab;
    if (this.tab === 'session') this.paintSessionPane();
    else if (this.tab === 'data') this.paintDataPane();
    else this.paintFiguresPane();
  }

  /** The band on top (the last run's receipt, or the one a chip asked
   *  for), then every name with its kind, type and preview. */
  private paintSessionPane() {
    const pane = this.panes.session;
    clearSafeSvgImages(pane);
    const asked = this.band && this.receipts.has(this.band.id) ? this.band.id : null;
    const shown = asked ?? this.last;
    const receipt = shown ? this.receipts.get(shown) : undefined;
    if (receipt && (!receipt.past || asked)) {
      const block = this.bandView(receipt);
      // A run landing in the docked card, or a chip's receipt shown there,
      // lights it once; a repaint while the light fades (the snapshot
      // arriving) carries on where it was.
      const since = performance.now() - this.landedAt;
      if (since < 1200) {
        block.classList.add('landed');
        block.style.animationDelay = `-${Math.round(since)}ms`;
      }
      pane.append(block);
    }
    const names = this.ordered();
    if (!names.length) {
      const empty = el('div', 's-empty');
      empty.append(
        el('p', 'lead', this.fresh ? 'A fresh session' : 'An empty session'),
        el('p', '', 'Run a cell (▶, or ⌘↩) and what it binds lands here: its names, their kinds and values, its figures.'),
        el('p', 'soft', 'The outputs under the cells are saved with the file; the session is what is in memory now.'),
      );
      pane.append(empty);
      return;
    }
    const head = el('div', 's-sec');
    head.append(el('span', '', 'In the session'), el('span', 'c', `${names.length}`));
    pane.append(head);
    const list = el('div', 's-list');
    for (const name of names) {
      const v = this.snapshot.get(name)!;
      const row = el('div', 's-row');
      row.dataset.name = name;
      const opens = isTabular(v) || !!v.figure;
      if (opens) row.classList.add('viewable');
      if (v.scratch) row.classList.add('scratch');
      if (this.unseen.has(name)) row.classList.add('new');
      if (isShort(v)) row.classList.add('short');
      const label = el('b', '', name);
      const type = el('span', 'ty', typeLabel(v) + (v.scratch ? ' · scratch' : ''));
      const preview = el('span', 'pv', v.preview);
      const owner = this.owner.get(name);
      const number = owner ? this.docView.cellNumber(owner) : null;
      const where = el('span', 'cl', number === null ? (owner ? 'deleted cell' : '') : `cell ${number}`);
      if (number !== null && owner) {
        where.title = 'Go to the cell';
        where.addEventListener('click', (e) => {
          e.stopPropagation();
          this.docView.goToCell(owner);
        });
      }
      row.append(glyph(kindGlyph(v)), label, type, preview, where);
      if (opens) {
        row.title = isTabular(v) ? 'Open in the data viewer' : 'Show the figure';
        row.addEventListener('click', () => (isTabular(v) ? void this.openTable(name) : void this.openFigure({ name })));
      } else row.title = `${name}: ${typeLabel(v)}`;
      list.append(row);
    }
    pane.append(list);
  }

  private paintDataPane() {
    const pane = this.panes.data;
    const pick = pane.querySelector<HTMLElement>('.s-pick')!;
    const note = pane.querySelector<HTMLElement>('.s-note')!;
    const tables = this.ordered().filter((name) => isTabular(this.snapshot.get(name)!));
    pick.replaceChildren(...tables.map((name) => {
      const button = el('button', name === this.dataName ? 'on' : '', name);
      button.type = 'button';
      button.addEventListener('click', () => void this.openTable(name));
      return button;
    }));
    pick.hidden = !tables.length;
    note.textContent = tables.length
      ? (this.dataName ? '' : 'Pick a table to page through it.')
      : 'No tables in the session yet: a DataFrame, a Series or a 2-D array opens here.';
    note.hidden = !note.textContent;
  }

  private paintFiguresPane() {
    const pane = this.panes.figures;
    const pick = pane.querySelector<HTMLElement>('.s-pick')!;
    const note = pane.querySelector<HTMLElement>('.s-note')!;
    const refs = this.figureRefs();
    const same = (a: FigureRef | null, b: FigureRef) =>
      !!a && ('name' in a ? 'name' in b && a.name === b.name : 'cell' in b && a.cell === b.cell);
    const buttons = refs.map((ref) => {
      const button = el('button', same(this.figure, ref) ? 'on' : '', this.figureLabel(ref));
      button.type = 'button';
      button.addEventListener('click', () => void this.openFigure(ref, true));
      return button;
    });
    pick.replaceChildren(...buttons);
    if (refs.length) {
      const hold = el('button', `s-hold${this.figHeld ? ' on' : ''}`);
      hold.type = 'button';
      hold.innerHTML = `${icon('pin')}<span>${this.figHeld ? 'Held' : 'Follows'}</span>`;
      hold.title = this.figHeld ? 'Held on this figure: new figures wait below. Click to follow them.' : 'Follows each new figure. Click to hold this one.';
      hold.addEventListener('click', () => {
        this.figHeld = !this.figHeld;
        if (!this.figHeld && this.figWaiting) {
          const next = this.figWaiting;
          this.figWaiting = null;
          void this.openFigure(next);
        } else this.paintCard();
      });
      pick.append(hold);
    }
    pick.hidden = !refs.length;
    note.replaceChildren();
    if (!refs.length) note.textContent = 'No figures yet: a cell that draws one shows it here.';
    else if (this.figHeld && this.figWaiting) {
      const next = this.figWaiting;
      const go = el('button', 's-waiting', `New: ${this.figureLabel(next)} →`);
      go.type = 'button';
      go.addEventListener('click', () => {
        this.figWaiting = null;
        void this.openFigure(next, true);
      });
      note.append(go);
    } else if (!this.figure) note.textContent = 'Pick a figure.';
    note.hidden = !note.childNodes.length;
  }

  /** The figures there are: each named one in the session, and each run's
   *  drawing no name holds (by its cell). */
  private figureRefs(): FigureRef[] {
    const refs: FigureRef[] = this.ordered()
      .filter((name) => this.snapshot.get(name)?.figure)
      .map((name) => ({ name }));
    for (const id of this.docView.cellIds()) {
      const receipt = this.receipts.get(id);
      if (!receipt || receipt.past || !receipt.figures.length) continue;
      if (receipt.named.length || receipt.rows.some((row) => row.v.figure)) continue;
      refs.push({ cell: id });
    }
    return refs;
  }

  private figureLabel(ref: FigureRef): string {
    if ('name' in ref) return ref.name;
    const number = this.docView.cellNumber(ref.cell);
    return number === null ? 'a deleted cell' : `cell ${number}`;
  }

  /** A run drew: the Figures tab follows it, unless held on one. */
  private follow(id: string, receipt: Receipt) {
    const named = receipt.named[0] ?? receipt.rows.find((row) => row.v.figure)?.name;
    const ref: FigureRef = named ? { name: named } : { cell: id };
    if (this.figHeld && this.figure) {
      this.figWaiting = ref;
      return;
    }
    this.figure = ref;
    if (!this.cardEl.hidden && this.tab === 'figures') void this.renderFigure();
  }

  private async openTable(name: string) {
    if (this.away) return;
    this.dataName = name;
    this.tab = 'data';
    if (this.band && !this.band.held) this.band.back = undefined;
    if (!this.visible) this.openFloating();
    this.paintCard();
    await this.data.open(name);
    if (this.data.showing !== name) this.dataName = null;
    this.paintCard();
  }

  private async openFigure(ref: FigureRef, chosen = false) {
    if (this.away) return;
    this.figure = ref;
    if (chosen && this.figWaiting) this.figWaiting = null;
    this.tab = 'figures';
    if (this.band && !this.band.held) this.band.back = undefined;
    if (!this.visible) this.openFloating();
    this.paintCard();
    await this.renderFigure();
  }

  private async renderFigure() {
    const ref = this.figure;
    if (!ref) return;
    if ('name' in ref) {
      await this.figs.openFigure(ref.name);
    } else {
      const receipt = this.receipts.get(ref.cell);
      if (receipt?.figures.length) this.figs.showDrawn(receipt.figures, this.figureLabel(ref));
      else this.figs.close();
    }
    this.paintCard();
  }

  // ---------- the receipt, drawn: the card beside the cell, and the band ----------

  /** "Cell 2": the cell as the person counts the code cells, or – once it
   *  is gone. */
  private cellName(id: string): string {
    const number = this.docView.cellNumber(id);
    return number === null ? '–' : String(number);
  }

  private receiptView(receipt: Receipt, context: CardKind): HTMLElement {
    const box = el('div', 'rv');
    if (receipt.past) box.classList.add('past');
    const isLast = this.last === receipt.id;
    const head = el('div', 'r-head');
    head.append(el('i', `r-dot${isLast ? '' : ' grey'}`));
    // "Cell 2 · this run": the second half gives way on a slim card.
    const when = receipt.past ? 'before the restart' : context === 'fresh' ? 'this run' : isLast ? 'last run' : 'earlier';
    const what = el('span', 't', `Cell ${this.cellName(receipt.id)}`);
    what.append(el('span', 'sub', ` · ${when}`));
    if (!receipt.ok) what.append(' · failed');
    head.append(what);
    head.append(el('span', 'took', took(receipt.ms)));
    if (context === 'fresh' || context === 'held') {
      const pin = el('button', `hb${context === 'held' ? ' on' : ''}`);
      pin.type = 'button';
      pin.innerHTML = icon('pin');
      pin.title = context === 'held' ? 'Kept here until you close it' : 'Keep it here (a click, or p)';
      pin.addEventListener('click', () => this.holdCard());
      const close = el('button', 'hb', '✕');
      close.type = 'button';
      close.title = context === 'fresh' ? 'Put it away (Esc)' : 'Close (Esc)';
      close.addEventListener('click', () => (context === 'fresh' ? this.tuck() : this.hideCard()));
      head.append(pin, close);
    }
    box.append(head);

    if (receipt.figures.length) box.append(this.figureView(receipt, false));

    if (receipt.rows.length) {
      const table = el('table', 'r-vars');
      const body = el('tbody');
      for (const row of receipt.rows) {
        const tr = el('tr');
        const opens = isTabular(row.v) || !!row.v.figure;
        if (opens) tr.classList.add('viewable');
        if (row.v.scratch) tr.classList.add('scratch');
        // A slim card shows a short value in place of its type; the type
        // stays in the row's tooltip.
        if (isShort(row.v)) tr.classList.add('short');
        const mark = el('td', `m${row.mark === '+' ? ' new' : ''}`, row.mark);
        mark.title = row.mark === '+' ? 'new: first bound by this run' : row.inPlace ? 'changed in place by this run' : 'rebound by this run';
        tr.append(mark, el('td', 'n', row.name), el('td', 'ty', typeLabel(row.v)), el('td', 'pv', row.v.preview));
        if (opens) {
          tr.title = isTabular(row.v) ? 'Open in the data viewer' : 'Show the figure';
          tr.addEventListener('click', () => (isTabular(row.v) ? void this.openTable(row.name) : void this.openFigure({ name: row.name }, true)));
        } else tr.title = `${row.name}: ${typeLabel(row.v)}`;
        body.append(tr);
      }
      table.append(body);
      box.append(table);
    } else if (!receipt.figures.length) {
      box.append(el('div', 'r-none', receipt.ok ? 'This run bound nothing new.' : 'The run stopped before it bound anything.'));
    }

    if (receipt.unchanged.length && !receipt.past) {
      const also = el('div', 'r-also');
      also.append(el('b', '', 'unchanged'));
      const shown = receipt.unchanged.slice(0, 8);
      for (const name of shown) also.append(' · ', el('code', '', name));
      if (receipt.unchanged.length > shown.length) also.append(` · +${receipt.unchanged.length - shown.length}`);
      box.append(also);
    }

    const folder = this.folderView(receipt);
    if (folder) box.append(folder);
    if (context === 'fresh') box.append(el('div', 'r-hint', this.hint()));
    return box;
  }

  /** The receipt as the Session tab's top band (peek-v2's board): "Last
   *  run · cell 3", or "Earlier run · cell 2" for a chip's; each name on
   *  its line with its kind, its value under it — a table this small whole
   *  — and the figure at the card's width. */
  private bandView(receipt: Receipt): HTMLElement {
    const box = el('div', 'rv band');
    const isLast = this.last === receipt.id;
    if (receipt.past) box.classList.add('past');
    if (!isLast) box.classList.add('earlier');
    const head = el('div', 'r-head');
    head.append(el('i', `r-dot${isLast && !receipt.past ? '' : ' grey'}`));
    const when = receipt.past ? 'Before the restart' : isLast ? 'Last run' : 'Earlier run';
    const what = el('span', 't', `${when} · cell ${this.cellName(receipt.id)}`);
    if (!receipt.ok) what.append(' · failed');
    head.append(what, el('span', 'took', took(receipt.ms)));
    if (this.docView.cellNumber(receipt.id) !== null) {
      const go = el('button', 'go');
      go.append(el('span', 'sub', 'go there '), '→');
      go.title = 'Go to the cell';
      go.type = 'button';
      go.addEventListener('click', () => this.docView.goToCell(receipt.id));
      head.append(go);
    }
    box.append(head);

    if (receipt.rows.length) {
      const list = el('div', 'b-rows');
      for (const row of receipt.rows) {
        const line = el('div', 'b-row');
        const opens = isTabular(row.v) || !!row.v.figure;
        if (opens) line.classList.add('viewable');
        if (row.v.scratch) line.classList.add('scratch');
        const mark = el('i', `m${row.mark === '+' ? ' new' : ''}`, row.mark);
        mark.title = row.mark === '+' ? 'new: first bound by this run' : row.inPlace ? 'changed in place by this run' : 'rebound by this run';
        line.append(mark, el('b', '', row.name), el('span', 'ty', typeLabel(row.v)));
        if (opens) {
          line.title = isTabular(row.v) ? 'Open in the data viewer' : 'Show the figure';
          line.addEventListener('click', () => (isTabular(row.v) ? void this.openTable(row.name) : void this.openFigure({ name: row.name }, true)));
        }
        list.append(line);
        if (row.v.figure) continue; // the figure itself shows below
        const mini = this.miniFor(receipt, row);
        const value = el('div', mini ? 'b-val' : 'b-val pv');
        if (mini) value.append(miniTable(mini, row.v.type === 'Series' || (mini.columns?.length ?? 0) === 1));
        else value.textContent = row.v.preview;
        list.append(value);
      }
      box.append(list);
    } else if (!receipt.figures.length) {
      box.append(el('div', 'r-none', receipt.ok ? 'This run bound nothing new.' : 'The run stopped before it bound anything.'));
    }
    if (receipt.figures.length) box.append(this.figureView(receipt, true));
    const folder = this.folderView(receipt);
    if (folder) box.append(folder);
    return box;
  }

  /** The figure a run drew: a thumbnail beside its name on the card, the
   *  card's width in the band. A click shows it in the Figures tab. */
  private figureView(receipt: Receipt, wide: boolean): HTMLElement {
    const fig = el('div', `r-fig${wide ? ' wide' : ''}`);
    const thumb = el('div', 'thumb');
    const image = createSafeSvgImage(receipt.figures[0], 'Figure drawn by this run');
    if (image) thumb.append(image);
    const name = receipt.named[0] ?? receipt.rows.find((row) => row.v.figure)?.name;
    const label = el('div', 'fl', name ?? 'a figure');
    label.append(el('small', '', `${receipt.figures.length} figure${receipt.figures.length === 1 ? '' : 's'}, drawn by this run`));
    fig.append(thumb, label);
    fig.title = 'Show it in the Figures tab';
    fig.addEventListener('click', () => void this.openFigure(name ? { name } : { cell: receipt.id }, true));
    return fig;
  }

  private folderView(receipt: Receipt): HTMLElement | null {
    const folder = folderLine(receipt);
    if ((!folder.values.length && !folder.figs.length) || receipt.scratch) return null;
    const line = el('div', 'r-folder');
    if (this.hooks.hasFolder()) {
      line.append(el('b', '', 'to the folder'));
      if (folder.values.length) line.append(' · values.json: ', el('code', '', folder.values.join(', ')));
      for (const fig of folder.figs) line.append(' · ', el('code', '', fig));
    } else {
      line.append(el('b', '', 'no folder yet'), ' · values.json and figs/ wait for a save');
    }
    return line;
  }

  /** A table small enough to show whole in the band (six rows and columns
   *  at most), paged from the kernel once per receipt; null while it is
   *  asked, or when the name has changed since that run. */
  private miniFor(receipt: Receipt, row: ReceiptRow): TableWindow | null {
    const v = row.v;
    if (!isTabular(v) || receipt.past || !this.hooks.ready()) return null;
    const rows = v.shape?.[0] ?? v.length ?? Infinity;
    const cols = v.type === 'Series' ? 1 : v.shape?.[1] ?? 1;
    if (rows < 1 || rows > MINI_ROWS || cols > MINI_COLS) return null;
    const now = this.snapshot.get(row.name);
    if (!now || summary(now) !== summary(v)) return null;
    let held = this.minis.get(receipt);
    if (!held) this.minis.set(receipt, (held = new Map()));
    const known = held.get(row.name);
    if (known === 'wait') return null;
    if (known !== undefined) return known;
    held.set(row.name, 'wait');
    void this.kernel.table(row.name, 0, MINI_ROWS).then((win) => {
      held!.set(row.name, win && !win.error && win.rows?.length ? win : null);
      if (win && !this.cardEl.hidden && this.tab === 'session') this.paintCard();
    });
    return null;
  }

  // ---------- keys, clicks, scrolling ----------

  private listen() {
    window.addEventListener('keydown', (e) => {
      if (e.isComposing || document.querySelector('.tb-menu:not([hidden])')) return;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      if (e.key === 'Escape') {
        this.carriedAt = performance.now();
        // Never prevented: in a cell, Esc also arms the kind chord.
        if (this.card?.kind === 'fresh') this.tuck();
        else if (this.card) this.hideCard();
        else if (this.band?.held) this.clearBand();
        else if (this.floating) this.closeCard();
        return;
      }
      if (plain && (e.key === 'p' || e.key === 'P') && this.card?.kind === 'fresh' && !isTextEntry(document.activeElement)) {
        e.preventDefault();
        this.holdCard();
        return;
      }
      const typing = plain && (e.key.length === 1 || ['Enter', 'Backspace', 'Delete', 'Tab'].includes(e.key));
      const shifted = e.shiftKey && !e.metaKey && !e.ctrlKey && e.key === 'Enter';
      if (typing || shifted) {
        this.carriedAt = performance.now();
        if (this.card?.kind === 'fresh') this.tuck();
      }
    }, { capture: true });

    // The fresh card's hint follows the focus: "p keeps it" only while p
    // would not type.
    const rehint = () => {
      if (this.card?.kind !== 'fresh') return;
      const hint = this.receiptEl.querySelector('.r-hint');
      if (hint) hint.textContent = this.hint();
    };
    document.addEventListener('focusin', rehint);
    document.addEventListener('focusout', rehint);

    document.addEventListener('mousedown', (e) => {
      const target = e.target as Element;
      this.carriedAt = performance.now();
      const onChip = !!target.closest?.('.rchip');
      if (this.card && !this.receiptEl.contains(target) && !onChip) {
        if (this.card.kind === 'fresh') this.tuck();
        else if (this.card.kind === 'hover' || !target.closest?.('#session')) this.hideCard();
      }
      if (this.band?.held && !onChip && !this.cardEl.contains(target)) this.clearBand();
      if (this.floating && !this.cardEl.contains(target) && !this.pill.contains(target) &&
        !this.toggle.contains(target) && !this.receiptEl.contains(target) && !target.closest?.('.tb-menu')) {
        this.closeCard();
      }
    }, true);

    let frame = 0;
    const reflow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => this.layout());
    };
    // The pill's room changes with the window: how many names fit.
    let pillFrame = 0;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(pillFrame);
      pillFrame = requestAnimationFrame(() => this.paintPill());
    });
    this.doc.addEventListener('scroll', () => {
      if (this.card) reflow();
    }, { passive: true });
    // Below the floor the room scrolls sideways: the receipt card follows
    // (the docked card is inside the room and goes with it).
    this.room.addEventListener('scroll', () => {
      if (this.card) reflow();
    }, { passive: true });
    window.addEventListener('resize', reflow);
    new ResizeObserver(reflow).observe(this.doc);
    // Source and grid views have no cells to stand beside: the cards go,
    // the column stands as those views have it, the pill rests.
    new MutationObserver(() => {
      if (this.away) {
        this.dropCard(true);
        if (this.floating) this.closeCard();
      }
      this.layout();
      this.paintPill();
    }).observe(document.body, { attributes: true, attributeFilter: ['data-view', 'data-cells'] });
  }
}
