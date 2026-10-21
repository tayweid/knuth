// The session (docs/SESSION.md): one data structure, the receipt
// (receipts.ts), under three surfaces.
//
//   The receipt card. A run's receipt appears beside the cell that ran, in
//   the frame's dark glass, eases in and flies straight up along a curve
//   into the session pill, landing on the chip for what it made (a
//   figure, a table, names), which lights as it lands. A click on it, `p` (when p would not type) or its pin keeps it
//   in place. It stands in the room's margin, its width following the
//   margin; the column never moves for it, and a margin too narrow lays it
//   over the column's right edge.
//
//   The chip. Once a receipt has flown, a small chip stays at the cell's
//   right corner (the ledger's folded tab): a glyph for what the run made
//   (a figure, a table, names) and a count. Hover opens the receipt again
//   past it, where the margin holds a card; a click holds it; a click
//   elsewhere or Esc puts it away. Amber when the cell is stale, faded
//   after a restart. It never takes the column's width.
//
//   The Session column. The pill at the bar's right end holds the kernel's
//   status and three chips — variables, data, figures — each lit when the
//   session holds one of its kind, blue while one is new, never saying
//   what or how many (Taylor, 2026-10-21). A chip opens its page in a
//   second column beside the cells, on the page, in the cells' own look
//   (Taylor, 2026-10-21: "like separate panes beside the cells page, not
//   hovering over it"); another chip turns the page, the lit one or the
//   column's ✕ closes it. The cells slide left for it by only what it
//   lacks (peek-v2's board), on opening, never on a run.
//
// While the column is open a run's receipt lands in the Variables page's
// band (no card flies), and a cell chip's hover or click shows its cell's
// receipt there. (Until 2026-10-21 the card floated from the pill and a pin
// docked it, its three parts one under another, each folding.)

import type { Kernel, NamespaceVar } from './kernel/kernel.ts';
import type { DocumentView, RunInfo } from './document-view.ts';
import { columnZoom, onColumnZoom } from './column-zoom.ts';
import { icon } from './icons.ts';
import { clearSafeSvgImages, createSafeSvgImage } from './safe-svg.ts';
import { Viewer, isTabular } from './viewers.ts';
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
  summary,
  took,
  typeLabel,
  type Receipt,
  type ReceiptRow,
} from './receipts.ts';

type Tab = 'session' | 'data' | 'figures';
/** fresh: a run's, about to fly; hover: a chip's, read-only; held: kept in
 *  place (a click, p, its pin, or a chip's click) until it is put away. */
type CardKind = 'fresh' | 'hover' | 'held';
/** Where a receipt card stands: over the chips' lane, 6 px from the column
 *  (a run's card and one kept from it, its chip hidden meanwhile; a chip's
 *  click where the margin past the chip is short), or past the chip with
 *  the column where it stands (a chip's hover, or its click where that
 *  fits). */
type Place = 'lane' | 'past';
interface Card {
  id: string;
  kind: CardKind;
  place: Place;
  /** A run's card, or one kept from it: it says "this run". */
  fromRun: boolean;
}
type FigureRef = { name: string } | { cell: string };

/** A run's receipt (beside the cell, the column never moving for it)
 *  flies as soon as it has eased in (#receipt's
 *  0.24 s show), seen arriving and then going, with no pause between. */
export const SHOW_MS = 240;
/** The flight up into the pill. */
export const FLY_MS = 460;
/** The column's slide, on the pin (peek-v2's 0.36 s). */
export const SLIDE_MS = 360;
/** The chips' lane beside the column (6 + the chip + 6). */
const CHIP_LANE = 46;
/** The column (#sheet's 52rem), and the floor it narrows to while the
 *  Session card is docked, at zoom 1: both times the column's zoom
 *  (column-zoom.ts) where they are used. */
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
 *  values only), 160 at the least, or it lies over the column's right
 *  edge (fitCard). */
const CARD_GAP = 8;
const CARD_TIE = 6;
const CARD_MAX = 300;
const CARD_SLIM = 270;
const CARD_FLOOR = 160;
/** A value whose preview says it in this many characters shows in a slim
 *  card in place of its type ("n 1200", not "n int"); a float, to six
 *  significant digits (briefValue). */
const SHORT_PREVIEW = 16;
/** A receipt card lists this many names; a run that bound more says how
 *  many more, and the Session card has them all. */
const RECEIPT_ROWS = 8;
/** A chip's title names this many. */
const CHIP_TITLE_NAMES = 12;
/** The page the column was left open on (per window, with the last
 *  choice as a new window's start); empty when it was closed. */
const PAGE_KEY = 'knuth-session-page';
const PAGES: Tab[] = ['session', 'data', 'figures'];
/** Each page's name, in the column's header and the pill chip's title. */
const PAGE_NAME: Record<Tab, string> = { session: 'Variables', data: 'Data', figures: 'Figures' };
const isPage = (value: string | null): value is Tab => value === 'session' || value === 'data' || value === 'figures';

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

/** A value its preview says in a few characters: a number (a float to six
 *  significant digits), a short string, a short list. */
function isShort(v: NamespaceVar): boolean {
  const brief = briefValue(v);
  return !isTabular(v) && !v.figure && brief.length <= SHORT_PREVIEW && !brief.includes('\n');
}

/** A value's preview where a narrow row shows it: the brief form first,
 *  which a narrow card shows in place of the full one (CSS), when they
 *  differ (a float to six significant digits). */
function valueCell(v: NamespaceVar, tag: 'td' | 'span'): HTMLElement {
  const cell = el(tag, 'pv');
  const brief = briefValue(v);
  if (brief === v.preview) cell.textContent = v.preview;
  else cell.append(el('span', 'brief', brief), el('span', 'full', v.preview));
  return cell;
}

/** A short value's tooltip: its type, and its whole value when the row
 *  shows it rounded. */
function valueTitle(name: string, v: NamespaceVar): string {
  return `${name}: ${typeLabel(v)}${briefValue(v) !== v.preview ? ` · ${v.preview}` : ''}`;
}

/** The time, as a fraction of the slide's, at which the slide's curve —
 *  cubic-bezier(.2, .7, .2, 1), #sheet.slide's — has gone `p` of the way. */
function slideTime(p: number): number {
  const at = (s: number, a: number, b: number) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const s = (lo + hi) / 2;
    if (at(s, 0.7, 1) < p) lo = s;
    else hi = s;
  }
  return at(hi, 0.2, 0.2);
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
  /** The column's measure and its floor, at the column's zoom. */
  column: number;
  columnFloor: number;
}

/** Where the column stands in a doc `width` wide — #sheet's CSS rule, worked
 *  out here so a card can be placed where the column is going rather than
 *  where it is mid-slide. `need`: what the docked card needs beside it,
 *  which slides the column left and then narrows it to the floor. */
function columnAt(f: Frame, width: number, need: number) {
  const content = width - f.padL - f.padR - f.sb;
  const col = Math.min(content, Math.max(Math.min(f.columnFloor, content), Math.min(f.column, content - need)));
  const margin = Math.max(0, Math.min((content - f.column) / 2, content - f.column - need));
  return { content, col, margin, right: f.padL + margin + col };
}

/** The docked card (peek-v2's board): clamp(320, what is beside the column
 *  at the room's left, 380) wide, past the chips' lane, 10 px in from the
 *  room's right edge. `need` is what the column gives it; `floor`, the
 *  doc's width once the column is at its floor, under which the room
 *  scrolls sideways rather than the card lie over the column. */
function boardAt(f: Frame) {
  const content = f.width - f.padL - f.padR - f.sb;
  const free = f.width - BOARD_GAP - f.padL - Math.min(f.column, content) - CHIP_LANE;
  const width = Math.round(Math.max(BOARD_MIN, Math.min(free, BOARD_MAX)));
  const need = CHIP_LANE + width + BOARD_GAP - f.padR - f.sb;
  const floor = f.padL + f.columnFloor + CHIP_LANE + width + BOARD_GAP;
  const column = columnAt(f, Math.max(f.width, floor), need);
  return { width, need, floor: floor > f.width ? floor : 0, left: column.right + CHIP_LANE };
}

export class Session {
  /** The session as the page last knew it, by name. */
  private snapshot = new Map<string, NamespaceVar>();
  private receipts = new Map<string, Receipt>();
  /** Which cell made each name (its latest receipt holds it). */
  private owner = new Map<string, string>();
  /** The cell whose receipt is the last run's. */
  private last: string | null = null;
  /** New names nobody has looked at yet: their chips blue in the pill. */
  private unseen = new Set<string>();
  /** New names a fresh receipt still holds, until it lands in the pill. */
  private pending = new Set<string>();
  /** A restart emptied the session: the pill's title says "fresh session". */
  private fresh = false;
  /** The page the Session column shows, or null while it is closed. */
  private page: Tab | null;
  private card: Card | null = null;
  /** The column open: the cell whose receipt the band shows in place of
   *  the last run's (a chip hovered, or clicked: held), and the page to go
   *  back to when a hover ends. */
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
  /** What #sheet's CSS is told: the docked card's need, and the doc's
   *  floor while docked. */
  private column = { need: 0, floor: 0 };
  private slideTimer = 0;
  /** Runs started and not yet finished, and those that started while
   *  another was still going. The kernel takes requests in order, so a run
   *  queued with others gets no snapshot of its own (ran, settled). */
  private inFlight = 0;
  private startedQueued = new Set<string>();

  private readonly pill: HTMLButtonElement;
  private readonly chips: Record<Tab, HTMLElement>;
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
    private hooks: SessionHooks,
  ) {
    this.room = document.getElementById('layout')!;
    this.doc = document.getElementById('doc')!;
    this.sheet = document.getElementById('sheet')!;
    // The open page is per window (a reload keeps it); a new window starts
    // as the last one was left.
    const page = readStore(() => sessionStorage, PAGE_KEY) ?? readStore(() => localStorage, PAGE_KEY);
    this.page = isPage(page) ? page : null;

    // The pill: the kernel's status (#kernel-status, untouched: the shell's
    // smoke reads its words), a hairline and the three chips.
    this.pill = document.getElementById('session-pill') as HTMLButtonElement;
    const chip = (part: Tab) => this.pill.querySelector<HTMLElement>(`.sp-chip[data-part="${part}"]`)!;
    this.chips = { session: chip('session'), data: chip('data'), figures: chip('figures') };
    this.pill.addEventListener('mousedown', (e) => e.preventDefault());
    // While the kernel is not ready the chips are hidden and the status is
    // the way to the onboarding.
    this.pill.addEventListener('click', () => {
      if (!this.hooks.ready()) this.hooks.showOnboarding();
    });
    for (const part of PAGES) {
      const button = this.chips[part];
      button.addEventListener('animationend', () => button.classList.remove('land'));
      button.addEventListener('click', () => {
        if (this.hooks.ready()) this.togglePage(part);
      });
    }

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
      // The card keeps no focus, its buttons neither (their click still
      // comes, and Tab still reaches them): the caret stays in the cell.
      e.preventDefault();
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
        <span class="s-title"></span>
        <button type="button" class="s-close" title="Close" aria-label="Close">✕</button>
      </div>
      <div class="s-body">
        <div class="s-pane" data-pane="session" id="s-pane-session"></div>
        <div class="s-pane" data-pane="data" id="s-pane-data"><div class="s-pick"></div><div class="s-view"></div><div class="s-note"></div></div>
        <div class="s-pane" data-pane="figures" id="s-pane-figures"><div class="s-pick"></div><div class="s-view"></div><div class="s-note"></div></div>
      </div>`;
    this.room.append(this.cardEl);
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
    this.cardEl.querySelector('.s-close')!.addEventListener('click', () => this.closePage());

    this.listen();
    this.paintPill();
    if (this.page) this.showColumn(false);
  }

  // ---------- what the document view and main tell the session ----------

  /** A run finished: its receipt, and where it shows. */
  ran(run: RunInfo): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    // A run queued with others has no snapshot of its own: one asked for
    // below comes after the runs behind it have run too, and the session
    // as the page knows it before this run lacks what the snapshot would
    // have shown of the runs before it. Its receipt keeps what it reported,
    // never crediting it with their names or their changes (settled).
    const queued = this.startedQueued.delete(run.id) || this.inFlight > 0;
    const before = new Map(this.snapshot);
    const receipt = receiptFromRun(run, before);
    this.snapshot = overlay(before, receipt);
    this.fresh = false;
    this.receipts.set(run.id, receipt);
    this.last = run.id;
    // The source view's whole-file editor is no cell: what it binds is the
    // session's, unowned, until a cell binds it.
    if (run.id !== 'source') for (const row of receipt.rows) this.owner.set(row.name, run.id);
    // A run on its own replaces the last run's blue; a batch adds up.
    if (!run.batch) this.unseen.clear();
    const added = receipt.rows.filter((row) => row.mark === '+').map((row) => row.name);
    for (const name of added) this.unseen.add(name);
    const peek = !this.docked && !run.batch && run.ok;
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
    void this.kernel.namespace().then((vars) => this.settled(receipt, before, vars, late, endedAt, queued));
  }

  /** A run is starting: a fresh receipt still up flies home first. */
  runStarting(id: string): void {
    if (this.inFlight > 0) this.startedQueued.add(id);
    this.inFlight++;
    if (this.card?.kind === 'fresh') this.tuck();
    else if (this.card?.kind === 'hover') this.dropCard();
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
    this.unseen.clear();
    this.pending.clear();
    this.inFlight = 0;
    this.startedQueued.clear();
    this.fresh = true;
    this.band = null;
    this.dropCard();
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
    this.dropCard();
    this.paintPill();
    this.paintCard();
  }

  /** A cell's row was built: hang its chip. */
  decorate(id: string, row: HTMLElement): void {
    this.paintChip(id, row);
  }

  /** The tables a cell's last run left, by name: a DataFrame or a 2-D
   *  array, what a name's row draws the table glyph for (kindGlyph; a
   *  Series is a column, and counting it put a table on nearly every
   *  pandas cell), which the scroll rail marks (rail-marks.ts). A
   *  restart's past receipts still count: the readout is still there. */
  tables(id: string): string[] {
    const receipt = this.receipts.get(id);
    return receipt ? receipt.rows.filter((row) => kindGlyph(row.v) === 'table').map((row) => row.name) : [];
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
      column: COLUMN * columnZoom(),
      columnFloor: COLUMN_FLOOR * columnZoom(),
    };
  }

  /** Everything the session lays over the room: where the column stands
   *  (#sheet's --need, #doc's --board-floor), the receipt card and the
   *  Session card. `slide`: a pin, which the column follows over SLIDE_MS;
   *  a resize or a scroll moves it at once. A run never changes what the docked card needs. */
  private layout(slide = false) {
    const inCells = !document.body.dataset.view;
    if (this.card) {
      const row = this.docView.cellRow(this.card.id);
      if (!row || !row.isConnected || !inCells || this.docked) this.dropCard();
    }
    const f = this.frame();
    const board = this.docked && inCells ? boardAt(f) : null;
    let fit = this.card ? this.fitCard(f, this.card.place) : null;
    if (this.card && !fit) {
      // Past the chip no longer fits (the window narrowed): a kept card
      // stands as a run's does, a hover card goes.
      if (this.card.kind === 'held') fit = this.fitCard(f, (this.card.place = 'lane'));
      else this.dropCard();
    }
    this.setColumn(board?.need ?? 0, board?.floor ?? 0, slide);
    if (this.card && fit) this.placeCard(f, fit);
    this.placeSessionCard(f, board);
  }

  /** Tell #sheet where to stand. */
  private setColumn(need: number, floor: number, slide: boolean) {
    const now = this.column;
    const moved = Math.abs(now.need - need) > 0.5;
    const sliding = moved && slide && !reducedMotion();
    if (moved) {
      if (sliding) {
        this.sheet.classList.add('slide');
        clearTimeout(this.slideTimer);
        this.slideTimer = window.setTimeout(() => this.sheet.classList.remove('slide'), SLIDE_MS + 60);
      }
      this.sheet.style.setProperty('--need', `${need}px`);
    }
    if (Math.abs(now.floor - floor) > 0.5) this.doc.style.setProperty('--board-floor', `${floor}px`);
    this.column = { need, floor };
  }

  /** The receipt card beside the column, in the viewport: as wide as the
   *  margin gives, up to 300. The column never moves for it.
   *
   *  Over the lane ('lane': a run's card): a margin under 160 lays the
   *  card, 160 wide, at the room's right edge over the column's.
   *
   *  Past the chip ('past': a chip's hover): a margin that leaves the card
   *  less than 160 gives no card (null). */
  private fitCard(f: Frame, place: Place): { left: number; width: number } | null {
    const docLeft = f.box.left - f.scroll;
    const edge = f.box.right - CARD_GAP;
    const at = (tie: number) => {
      const left = docLeft + columnAt(f, f.width, 0).right + tie;
      return { left, width: Math.min(CARD_MAX, edge - left) };
    };
    if (place === 'past') {
      const past = at(CHIP_LANE);
      return past.width >= CARD_FLOOR ? past : null;
    }
    const fit = at(CARD_TIE);
    if (fit.width >= CARD_FLOOR) return fit;
    const width = Math.min(CARD_FLOOR, f.box.width - 2 * CARD_GAP);
    return { left: f.box.right - CARD_GAP - width, width };
  }

  /** Its top on the cell's first line, kept inside the room. */
  private placeCard(f: Frame, fit: { left: number; width: number }) {
    if (!this.card) return;
    const row = this.docView.cellRow(this.card.id)!;
    const anchor = (row.querySelector('.cm-editor') ?? row).getBoundingClientRect();
    const style = this.receiptEl.style;
    style.width = `${fit.width}px`;
    this.receiptEl.classList.toggle('slim', fit.width < CARD_SLIM);
    const height = this.receiptEl.offsetHeight;
    style.left = `${fit.left}px`;
    style.top = `${Math.max(f.box.top + 10, Math.min(anchor.top, f.box.bottom - height - 10))}px`;
  }

  /** On the page — inside the room, so it scrolls sideways with it below
   *  the floor — beside the column past the chips' lane, the room's height
   *  less its margins: a column, whichever page it shows. */
  private placeSessionCard(f: Frame, board: ReturnType<typeof boardAt> | null) {
    // Source and grid views hide it where it is.
    if (this.cardEl.hidden || !board) return;
    const style = this.cardEl.style;
    style.left = `${board.left}px`;
    style.top = '12px';
    style.height = `${Math.max(160, f.box.height - 24)}px`;
    style.width = `${board.width}px`;
    this.cardEl.classList.toggle('narrow', board.width < 300);
  }

  // ---------- the receipt card ----------

  private hasContent(receipt: Receipt): boolean {
    return receipt.rows.length > 0 || receipt.figures.length > 0;
  }

  /** The snapshot after a run is in: what the AST missed joins the
   *  receipt. `late`: the run's own report had nothing to show, so its card
   *  waits for this. `queued`: other runs were queued with this one, before
   *  or behind it, so the snapshot is not this run's alone and the receipt
   *  keeps the run's own report (nothing found: no owner, no late card). */
  private settled(receipt: Receipt, before: Map<string, NamespaceVar>, vars: NamespaceVar[], late: boolean, endedAt: number, queued: boolean) {
    if (!this.hooks.ready()) return;
    const known = new Set(receipt.rows.map((row) => row.name));
    settle(receipt, before, vars, !queued);
    const found = receipt.rows.filter((row) => !known.has(row.name));
    for (const row of found) {
      if (receipt.id !== 'source') this.owner.set(row.name, receipt.id);
      if (row.mark === '+') {
        this.unseen.add(row.name);
        if (this.card?.id === receipt.id && this.card.kind === 'fresh') this.pending.add(row.name);
      }
    }
    this.take(vars);
    const current = this.receipts.get(receipt.id) === receipt;
    // A run whose news only the snapshot saw (a change in place) still
    // gets its card, unless the person has carried on since.
    if (current && late && !this.card && found.length && this.last === receipt.id && this.carriedAt < endedAt && !this.docked) {
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

  /** A receipt card: a run's (fresh, over the lane), a chip's hover (past
   *  the chip, only where that leaves the column where it is), or a chip's
   *  click (held: past the chip where it fits, else as a run's). */
  private showCard(id: string, kind: CardKind) {
    if (this.docked) return; // docked, a receipt shows in the band
    const past = kind !== 'fresh' && !!this.fitCard(this.frame(), 'past');
    if (kind === 'hover' && !past) return; // the chip's title names what it bound
    if (this.card?.kind === 'fresh' && this.card.id !== id) this.tuck();
    this.flightEnd?.();
    const previous = this.card?.id;
    this.card = { id, kind, place: past ? 'past' : 'lane', fromRun: kind === 'fresh' };
    clearTimeout(this.dwell);
    this.renderReceiptCard();
    this.receiptEl.hidden = false;
    this.receiptEl.classList.remove('show');
    this.layout(true);
    if (!this.card) return; // its cell is not on screen
    void this.receiptEl.offsetWidth;
    this.receiptEl.classList.add('show');
    if (previous && previous !== id) this.paintChip(previous);
    this.paintChip(id);
    // A run's card flies home as soon as it is in.
    if (kind === 'fresh') this.dwell = window.setTimeout(() => this.tuck(), SHOW_MS);
  }

  /** The receipt, in the card: a run's (fresh), a chip's (hover) or held. */
  private renderReceiptCard() {
    if (!this.card) return;
    const receipt = this.receipts.get(this.card.id);
    clearSafeSvgImages(this.receiptEl);
    if (!receipt) return;
    this.receiptEl.dataset.kind = this.card.kind;
    this.receiptEl.dataset.cell = this.card.id;
    this.receiptEl.append(this.receiptView(receipt, this.card.kind, this.card.fromRun));
  }

  private lookAtCard(looking: boolean) {
    if (!this.card) return;
    clearTimeout(this.hoverTimer);
    if (this.card.kind === 'hover' && !looking) {
      this.hoverTimer = window.setTimeout(() => this.dropCard(), 180);
    }
  }

  /** Every way out of a fresh receipt is the same flight: home, into the
   *  pill's chip for what it made, along a curve, shrinking, seen all the
   *  way in; the chip lights as it arrives, and the cell's chip takes its
   *  place at the cell. */
  private tuck() {
    if (!this.card) return;
    const { id, kind } = this.card;
    if (kind !== 'fresh') {
      this.dropCard();
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
      this.paintPill(landing, id);
      this.paintChip(id);
    };
    const card = this.receiptEl;
    if (reducedMotion() || !card.animate || card.hidden) {
      this.dropCard(true);
      land();
      return;
    }
    const from = card.getBoundingClientRect();
    const home = this.chips[this.landsOn(id)];
    const target = (home.getClientRects().length && home.getBoundingClientRect().width > 0 ? home : this.pill).getBoundingClientRect();
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
    // The chip lights as the card reaches the pill, still showing (seven
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
      if (!this.card) this.dropCard(true);
    };
    this.flightEnd = done;
    flight.onfinish = done;
    flight.oncancel = done;
  }

  /** A click on it, p, or its pin: the receipt stays where it is — the
   *  same place, the same width, a run's still over its hidden chip —
   *  until closed. */
  private holdCard() {
    if (!this.card || this.card.kind === 'held') return;
    const wasFresh = this.card.kind === 'fresh';
    this.card.kind = 'held';
    clearTimeout(this.dwell);
    clearTimeout(this.hoverTimer);
    if (wasFresh) {
      const landing = [...this.pending];
      this.pending.clear();
      this.paintPill(landing, this.card.id);
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
      this.paintPill(landing, this.card.id);
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

  /** The card put away on purpose (Esc with it up, its ✕, a click
   *  outside it): a fresh one flies home as ever. */
  private dismiss() {
    if (this.card?.kind === 'fresh') this.tuck();
    else this.dropCard();
  }

  // ---------- the chips ----------

  private paintChips() {
    for (const id of this.receipts.keys()) this.paintChip(id);
  }

  /** The chip's tooltip: the names its run bound (the first dozen), and
   *  what hover and a click do where the chip is now. */
  private chipTitle(receipt: Receipt, hover: boolean): string {
    const named = receipt.rows.map((r) => r.name);
    const listed = named.length > CHIP_TITLE_NAMES
      ? `${named.slice(0, CHIP_TITLE_NAMES).join(', ')} and ${named.length - CHIP_TITLE_NAMES} more`
      : named.join(', ');
    const does = hover ? 'hover for the receipt, click to keep it' : 'click for the receipt';
    return `${receipt.past ? 'Before the restart: ' : ''}${named.length ? listed : 'a figure'} — ${does}`;
  }

  /** The chip at a cell's right corner: what its last run made, and how
   *  many (99 and a raised + past that). Hidden while a card of that run
   *  stands over the lane (its fresh receipt, or the receipt kept from
   *  it). */
  private paintChip(id: string, row: HTMLElement | null = this.docView.cellRow(id)) {
    if (!row) return;
    let chip = row.querySelector<HTMLButtonElement>(':scope > .rchip');
    const receipt = this.receipts.get(id);
    const kind = receipt ? chipKind(receipt) : null;
    if (!receipt || !kind || (this.card?.id === id && this.card.place === 'lane')) {
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
        // Hover never moves the column: where the margin past the chip
        // cannot hold a card, there is none (the title names what the run
        // bound, and a click opens the receipt).
        const fits = !!this.fitCard(this.frame(), 'past');
        const receipt = this.receipts.get(id);
        if (receipt && chip) {
          chip.dataset.hover = fits ? '1' : '0';
          chip.title = this.chipTitle(receipt, fits);
        }
        if (!fits || this.card?.kind === 'held') return;
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
          this.hoverTimer = window.setTimeout(() => this.dropCard(), 180);
        }
      });
      chip.addEventListener('click', () => {
        clearTimeout(this.hoverTimer);
        if (this.docked) {
          if (this.band?.id === id && this.band.held) this.clearBand();
          else this.showBand(id, true);
          return;
        }
        if (this.card?.id === id && this.card.kind === 'held') this.dropCard();
        // Held where it stands: past the chip where the margin holds it (a
        // hover card stays put), else as a run's card, the column sliding
        // for it.
        else if (this.card?.id === id && this.card.kind === 'hover') this.holdCard();
        else this.showCard(id, 'held');
      });
      row.append(chip);
    }
    const on = this.card?.id === id || this.band?.id === id;
    const count = chipCount(receipt);
    chip.className = `rchip kind-${kind}${receipt.past ? ' past' : ''}${on ? ' on' : ''}`;
    // A three-digit count would push past the lane: 99, the + raised into
    // the chip's corner.
    chip.replaceChildren(kind === 'figure' ? printMark() : glyph(kind === 'table' ? 'table' : 'braces'), el('span', count > 99 ? 'n over' : 'n', String(Math.min(count, 99))));
    // What hover does is known once the pointer has come (mouseenter).
    chip.title = this.chipTitle(receipt, chip.dataset.hover !== '0');
    // Its accessible name offers no hover, which a keyboard never makes:
    // Enter or Space opens the receipt kept.
    chip.setAttribute('aria-label', `Receipt of cell ${this.cellName(id)}'s last run: ${this.chipTitle(receipt, false)}`);
  }

  // ---------- the band: the Variables page's top ----------

  /** The column open, a chip's hover (or click: held) shows its cell's
   *  receipt in the band — "Earlier run · cell 2" — lit and in view,
   *  rather than a card beside the cell. A hover from the Data or Figures
   *  page goes back to it when it ends. */
  private showBand(id: string, held: boolean) {
    if (!this.docked || !this.receipts.has(id)) return;
    const previous = this.band?.id;
    const back = held ? undefined : this.band?.back ?? (this.page !== 'session' ? this.page ?? undefined : undefined);
    this.band = { id, held, back };
    this.landedAt = performance.now();
    this.turnTo('session');
    this.panes.session.scrollTop = 0;
    if (previous && previous !== id) this.paintChip(previous);
    this.paintChip(id);
  }

  /** The band shows the last run again. */
  private clearBand() {
    if (!this.band) return;
    const { id, back } = this.band;
    this.band = null;
    if (back && this.page) this.turnTo(back);
    else this.paintCard();
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

  /** The pill's chip a receipt flies home to: Figures for a run that drew,
   *  Data for one that bound a table, else the variables. */
  private landsOn(id: string): Tab {
    const receipt = this.receipts.get(id);
    const kind = receipt ? chipKind(receipt) : null;
    return kind === 'figure' ? 'figures' : kind === 'table' ? 'data' : 'session';
  }

  /** The kernel's status, then the three chips: each lit when the session
   *  holds one of its kind (any name; a table; a figure — what the card's
   *  three parts list), blue while one of those is new. `landing`: the
   *  names a receipt just brought home and its cell, whose chip lights for
   *  a moment. */
  private paintPill(landing?: string[], from?: string) {
    const ready = this.hooks.ready();
    const away = this.away;
    this.pill.classList.toggle('ready', ready);
    this.pill.classList.toggle('open', this.docked && !away);
    if (ready && away) this.pill.setAttribute('aria-disabled', 'true');
    else this.pill.removeAttribute('aria-disabled');
    for (const part of PAGES) {
      const chip = this.chips[part];
      const on = this.page === part && !away;
      chip.classList.toggle('on', on);
      chip.setAttribute('aria-pressed', String(on));
      if (away) chip.setAttribute('aria-disabled', 'true');
      else chip.removeAttribute('aria-disabled');
    }
    if (!ready) {
      this.pill.title = 'The Python engine is not connected';
      return;
    }
    const names = this.ordered().filter((name) => !this.pending.has(name));
    const tables = names.filter((name) => isTabular(this.snapshot.get(name)!));
    const figures = this.figureRefs().filter((ref) => !('name' in ref) || !this.pending.has(ref.name));
    const unseen = names.filter((name) => this.unseen.has(name));
    const parts: Record<Tab, { has: boolean; isNew: boolean; held: string }> = {
      session: { has: names.length > 0, isNew: unseen.length > 0, held: names.length ? 'the session holds names' : 'none yet' },
      data: { has: tables.length > 0, isNew: unseen.some((name) => tables.includes(name)), held: tables.length ? 'the session holds a table' : 'no tables yet' },
      figures: { has: figures.length > 0, isNew: unseen.some((name) => this.snapshot.get(name)?.figure), held: figures.length ? 'the session holds a figure' : 'none yet' },
    };
    const lands = landing && from ? this.landsOn(from) : null;
    for (const part of ['session', 'data', 'figures'] as Tab[]) {
      const chip = this.chips[part];
      const { has, isNew, held } = parts[part];
      chip.classList.toggle('has', has);
      chip.classList.toggle('new', isNew);
      const does = away ? this.awayTitle() : this.page === part ? 'click to close it' : 'click to open it beside the cells';
      const title = `${PAGE_NAME[part]}: ${held} — ${does}`;
      if (chip.title !== title) chip.title = title;
      if (lands) chip.classList.remove('land');
      if (lands === part) {
        void chip.offsetWidth;
        chip.classList.add('land');
      }
    }
    if (!names.length && !figures.length) {
      this.pill.title = away ? this.awayTitle() : this.fresh ? 'A fresh session: run a cell to fill it' : 'Nothing in the session yet: run a cell';
      return;
    }
    const count = `The session: ${names.length} name${names.length === 1 ? '' : 's'}${figures.length ? `, ${figures.length} figure${figures.length === 1 ? '' : 's'}` : ''}`;
    this.pill.title = away ? `${count} — ${this.awayTitle()}` : count;
  }

  // ---------- the Session column ----------

  /** The column is open, on one of its pages. */
  private get docked(): boolean {
    return this.page !== null;
  }

  /** A pill chip: open the column on its page, turn to that page, or close
   *  the column when that page is the one showing. */
  private togglePage(page: Tab) {
    if (this.away) return;
    if (this.page === page) this.closePage();
    else this.openPage(page);
  }

  /** "+392 more · in Variables": the receipt goes home (a run's flies into
   *  the pill) and the column opens on Variables, every name listed. */
  private openSessionTab() {
    if (this.card?.kind === 'fresh') this.tuck();
    else this.dropCard();
    this.openPage('session');
  }

  /** Open the column on `page`, or turn to it if the column is open.
   *  Opening Variables is looking: the new names' blue goes. `render`:
   *  draw the followed figure on turning to Figures (openFigure draws its
   *  own). */
  private openPage(page: Tab, render = true) {
    if (this.away) return;
    if (this.band && !this.band.held) this.band.back = undefined;
    if (page === 'session') this.unseen.clear();
    if (this.page) {
      this.turnTo(page, true, render);
      return;
    }
    if (this.card) this.dropCard();
    this.page = page;
    this.savePage();
    this.showColumn(true, render);
  }

  /** The open column shows `page`; `remember` it for the window (a chip's
   *  hover turning to Variables for a moment is not remembered). */
  private turnTo(page: Tab, remember = false, render = true) {
    if (!this.page) return;
    this.page = page;
    if (remember) this.savePage();
    this.paintCard();
    this.paintPill();
    if (render && page === 'figures' && this.figure) void this.renderFigure();
  }

  /** The column appears beside the cells, which slide left by what it
   *  lacks. `animate`: opened now, not restored at boot. */
  private showColumn(animate: boolean, render = true) {
    const from = this.sheet.getBoundingClientRect().right;
    // How far past the column the chips reach (they ride with it): the
    // widest's right edge, inside the lane; none, or tucked inside the
    // cells on a narrow window, and the column's own edge is what counts.
    let reach = 0;
    for (const chip of this.sheet.querySelectorAll<HTMLElement>('.rchip')) reach = Math.max(reach, chip.getBoundingClientRect().right - from);
    this.cardEl.hidden = false;
    this.paintCard();
    this.layout(animate);
    if (animate && !reducedMotion() && !this.away) {
      // It fades in once the sliding cells and their chips have cleared
      // the place it stands — when the chips' right edge passes its left
      // on the slide's own curve — never over either mid-slide.
      const boardLeft = this.cardEl.getBoundingClientRect().left;
      const to = boardLeft - CHIP_LANE;
      const edge = from + Math.min(reach, CHIP_LANE);
      const delay = edge > boardLeft && from > to ? Math.round(slideTime(Math.min(1, (edge - boardLeft) / (from - to))) * SLIDE_MS) : 0;
      this.cardEl.animate(
        [{ opacity: 0, transform: 'translateY(-10px) scale(0.98)' }, { opacity: 1, transform: 'none' }],
        { duration: 220, delay, fill: 'backwards', easing: 'cubic-bezier(.2,.7,.2,1)' },
      );
    }
    // Under the floor the room scrolls sideways: bring the column's ✕
    // into view, where it was just opened.
    if (animate && this.column.floor > 0) this.room.scrollTo({ left: this.room.scrollWidth, behavior: reducedMotion() ? 'auto' : 'smooth' });
    this.paintPill();
    if (render && this.page === 'figures' && this.figure) void this.renderFigure();
  }

  /** The lit chip or the column's ✕: the column goes, the cells slide
   *  home. */
  private closePage() {
    if (!this.page) return;
    this.page = null;
    this.savePage();
    if (this.band) {
      const was = this.band.id;
      this.band = null;
      this.paintChip(was);
    }
    this.cardEl.hidden = true;
    this.layout(true);
    this.paintPill();
  }

  private savePage() {
    writeStore(() => sessionStorage, PAGE_KEY, this.page ?? '');
    writeStore(() => localStorage, PAGE_KEY, this.page ?? '');
  }

  /** Whether a page shows: the column up, on that page. */
  private shows(tab: Tab): boolean {
    return !this.cardEl.hidden && this.page === tab;
  }

  /** Repaint the page the column shows. */
  private paintCard() {
    if (this.cardEl.hidden || !this.page) return;
    this.cardEl.dataset.page = this.page;
    this.cardEl.querySelector('.s-title')!.textContent = PAGE_NAME[this.page];
    for (const [tab, pane] of Object.entries(this.panes)) pane.hidden = tab !== this.page;
    if (this.page === 'session') this.paintSessionPane();
    else if (this.page === 'data') this.paintDataPane();
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
    const touched = new Map<string, ReceiptRow>();
    if (receipt && (!receipt.past || asked)) {
      for (const row of receipt.rows) touched.set(row.name, row);
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
      const preview = valueCell(v, 'span');
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
      // What the run on the first line did to it, in the kind glyph's place.
      const did = touched.get(name);
      let lead = glyph(kindGlyph(v));
      if (did) {
        row.classList.add('touched');
        lead = el('i', `g m${did.mark === '+' ? ' new' : ''}`, did.mark);
        lead.title = did.mark === '+' ? 'new: first bound by this run' : did.inPlace ? 'changed in place by this run' : 'rebound by this run';
      }
      row.append(lead, label, type, preview, where);
      if (opens) {
        row.title = isTabular(v) ? 'Open in the data viewer' : 'Show the figure';
        row.addEventListener('click', () => (isTabular(v) ? void this.openTable(name) : void this.openFigure({ name })));
      } else row.title = valueTitle(name, v);
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
    note.textContent = !tables.length
      ? 'No tables yet. A DataFrame, a Series or a 2-D array shows here once a cell binds one.'
      : !this.dataName ? 'Pick a table to page through it.' : '';
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
    if (this.figHeld && this.figWaiting) {
      const next = this.figWaiting;
      const go = el('button', 's-waiting', `New: ${this.figureLabel(next)} →`);
      go.type = 'button';
      go.addEventListener('click', () => {
        this.figWaiting = null;
        void this.openFigure(next, true);
      });
      note.append(go);
    } else if (!refs.length) note.textContent = 'No figures yet. A figure shows here once a cell draws one.';
    else if (!this.figure) note.textContent = 'Pick a figure.';
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
    if (this.shows('figures')) void this.renderFigure();
  }

  private async openTable(name: string) {
    if (this.away) return;
    this.dataName = name;
    this.openPage('data');
    await this.data.open(name);
    if (this.data.showing !== name) this.dataName = null;
    this.paintCard();
  }

  private async openFigure(ref: FigureRef, chosen = false) {
    if (this.away) return;
    this.figure = ref;
    if (chosen && this.figWaiting) this.figWaiting = null;
    this.openPage('figures', false);
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

  private receiptView(receipt: Receipt, context: CardKind, fromRun: boolean): HTMLElement {
    const box = el('div', 'rv');
    if (receipt.past) box.classList.add('past');
    const isLast = this.last === receipt.id;
    const head = el('div', 'r-head');
    head.append(el('i', `r-dot${isLast ? '' : ' grey'}`));
    // "Cell 2 · this run": the second half gives way on a slim card. A
    // run's card kept in place still says "this run".
    const when = receipt.past ? 'before the restart' : fromRun && isLast ? 'this run' : isLast ? 'last run' : 'earlier';
    const what = el('span', 't', `Cell ${this.cellName(receipt.id)}`);
    what.append(el('span', 'sub', ` · ${when}`));
    if (!receipt.ok) what.append(' · failed');
    head.append(what);
    head.append(el('span', 'took', took(receipt.ms)));
    if (context === 'held') {
      const pin = el('button', 'hb on');
      pin.type = 'button';
      pin.innerHTML = icon('pin');
      pin.title = 'Kept here until you close it';
      const close = el('button', 'hb', '✕');
      close.type = 'button';
      close.title = 'Close (Esc)';
      close.addEventListener('click', () => this.dismiss());
      head.append(pin, close);
    }
    box.append(head);

    if (receipt.figures.length) box.append(this.figureView(receipt));

    if (receipt.rows.length) {
      const table = el('table', 'r-vars');
      const body = el('tbody');
      // A run that bound hundreds of names (a loop of globals) lists the
      // first few; the rest are a click away, in the Session card.
      const shown = receipt.rows.length > RECEIPT_ROWS + 1 ? receipt.rows.slice(0, RECEIPT_ROWS) : receipt.rows;
      for (const row of shown) {
        const tr = el('tr');
        const opens = isTabular(row.v) || !!row.v.figure;
        if (opens) tr.classList.add('viewable');
        if (row.v.scratch) tr.classList.add('scratch');
        // A slim card shows a short value in place of its type; the type
        // stays in the row's tooltip.
        if (isShort(row.v)) tr.classList.add('short');
        const mark = el('td', `m${row.mark === '+' ? ' new' : ''}`, row.mark);
        mark.title = row.mark === '+' ? 'new: first bound by this run' : row.inPlace ? 'changed in place by this run' : 'rebound by this run';
        tr.append(mark, el('td', 'n', row.name), el('td', 'ty', typeLabel(row.v)), valueCell(row.v, 'td'));
        if (opens) {
          tr.title = isTabular(row.v) ? 'Open in the data viewer' : 'Show the figure';
          tr.addEventListener('click', () => (isTabular(row.v) ? void this.openTable(row.name) : void this.openFigure({ name: row.name }, true)));
        } else tr.title = valueTitle(row.name, row.v);
        body.append(tr);
      }
      table.append(body);
      box.append(table);
      if (shown.length < receipt.rows.length) {
        const more = el('button', 'r-more');
        more.type = 'button';
        more.append(el('b', '', `+${receipt.rows.length - shown.length} more`), ' · in Variables');
        more.title = 'Every name this run bound, in the Session column\'s Variables page';
        more.addEventListener('click', () => this.openSessionTab());
        box.append(more);
      }
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
    return box;
  }

  /** The Session part's first line: which run the list's marks are from,
   *  "Last run · cell 3  12 ms", or "Earlier run · cell 2" for a chip's;
   *  a click on it goes to the cell. The names that run touched carry its
   *  + or ~ in the list itself (paintSessionPane): one list, never a second
   *  copy of the names above it (Taylor, 2026-10-17). */
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
    else if (!receipt.rows.length && !receipt.figures.length) what.append(' · bound nothing');
    head.append(what, el('span', 'took', took(receipt.ms)));
    if (this.docView.cellNumber(receipt.id) !== null) {
      head.classList.add('goes');
      head.title = 'Go to the cell';
      head.addEventListener('click', () => this.docView.goToCell(receipt.id));
    }
    box.append(head);
    return box;
  }

  /** The figure a run drew: a thumbnail beside its name on the card, the
   *  card's width in the band. A click shows it in the Figures tab. */
  private figureView(receipt: Receipt): HTMLElement {
    const fig = el('div', 'r-fig');
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

  /** Where a run's values and figures went, when there is a folder for
   *  them. With none, nothing: the toast offers one (main.ts), and a
   *  "no folder yet" on every receipt was noise (Taylor, 2026-10-17). */
  private folderView(receipt: Receipt): HTMLElement | null {
    const folder = folderLine(receipt);
    if ((!folder.values.length && !folder.figs.length) || receipt.scratch || !this.hooks.hasFolder()) return null;
    const line = el('div', 'r-folder');
    line.append(el('b', '', 'to the folder'));
    if (folder.values.length) line.append(' · values.json: ', el('code', '', folder.values.join(', ')));
    for (const fig of folder.figs) line.append(' · ', el('code', '', fig));
    return line;
  }

  // ---------- keys, clicks, scrolling ----------

  private listen() {
    window.addEventListener('keydown', (e) => {
      if (e.isComposing || document.querySelector('.tb-menu:not([hidden])')) return;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      if (e.key === 'Escape') {
        this.carriedAt = performance.now();
        // Claimed (prevented) only when it put something away, so that Esc
        // does not also take the cell into command mode (document-view.ts):
        // the next Esc does.
        if (this.card) this.dismiss();
        else if (this.band?.held) this.clearBand();
        else return;
        e.preventDefault();
        return;
      }
      const typing = plain && (e.key.length === 1 || ['Enter', 'Backspace', 'Delete', 'Tab'].includes(e.key));
      const shifted = e.shiftKey && !e.metaKey && !e.ctrlKey && e.key === 'Enter';
      if (typing || shifted) {
        this.carriedAt = performance.now();
        // Typing on, or Shift-Enter stepping: a fresh card goes home.
        if (this.card?.kind === 'fresh') this.tuck();
      }
    }, { capture: true });

    document.addEventListener('mousedown', (e) => {
      const target = e.target as Element;
      this.carriedAt = performance.now();
      const onChip = !!target.closest?.('.rchip');
      // A click anywhere but on the card or a chip puts the card away:
      // clicking back into the text is getting on with it (Taylor,
      // 2026-10-06: "basically instantly").
      if (this.card && !this.receiptEl.contains(target) && !onChip) {
        if (this.card.kind === 'fresh') this.tuck();
        else if (this.card.kind === 'hover' || !target.closest?.('#session')) this.dropCard();
      }
      if (this.band?.held && !onChip && !this.cardEl.contains(target)) this.clearBand();
    }, true);

    let frame = 0;
    const reflow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => this.layout());
    };
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
    onColumnZoom(reflow);
    // Source and grid views have no cells to stand beside: the cards go,
    // the column stands as those views have it, the pill rests.
    new MutationObserver(() => {
      if (this.away) this.dropCard(true);
      this.layout();
      this.paintPill();
    }).observe(document.body, { attributes: true, attributeFilter: ['data-view', 'data-cells'] });
  }
}
