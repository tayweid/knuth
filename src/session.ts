// The session (docs/SESSION.md): one data structure, the receipt
// (receipts.ts), under three surfaces.
//
//   The receipt card. A run's receipt appears beside the cell that ran, in
//   the frame's dark glass, and stays while you look; keep typing, press
//   Esc, click elsewhere, or let it be for six seconds, and it flies up
//   along a curve into the session pill, whose names update as it lands
//   (new names blue). `p`, or its pin, holds it in place.
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
//   the pin docks it beside the column, on the page, in its own look.
//
// Three modes, a segmented control in the card's header: Peek (the card
// and the flight), Silent (no card, no motion: the chip and the pill update
// quietly), Pinned (the card docked; a run's receipt lands in its top).
// The cell column is never touched: every surface here lies over the room.

import type { Kernel, NamespaceVar } from './kernel/kernel.ts';
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
  took,
  typeLabel,
  type Receipt,
} from './receipts.ts';

/** How a run's receipt shows when the card is not docked. */
export type Mode = 'peek' | 'silent';
type Tab = 'session' | 'data' | 'figures';
/** fresh: a run's, about to fly; hover: a chip's, read-only; held: kept in
 *  place (p, its pin, or a chip's click) until it is put away. */
type CardKind = 'fresh' | 'hover' | 'held';
type FigureRef = { name: string } | { cell: string };

/** How long a fresh receipt stays when nothing else puts it away. */
export const DWELL_MS = 6000;
/** After the pointer leaves a fresh receipt it was resting on. */
const DWELL_AFTER_LOOK_MS = 2000;
/** The flight up into the pill. */
export const FLY_MS = 460;
/** The chips' lane beside the column (6 + the chip + 6): the cards sit
 *  past it, so a chip is never under a card on a wide window. */
const CHIP_LANE = 46;
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

export class Session {
  /** The session as the page last knew it, by name. */
  private snapshot = new Map<string, NamespaceVar>();
  private receipts = new Map<string, Receipt>();
  /** Which cell made each name (its latest receipt holds it). */
  private owner = new Map<string, string>();
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
      // A click on a chip's card holds it; the card keeps no focus.
      if (!(e.target as Element).closest('button')) e.preventDefault();
      if (this.card?.kind === 'hover') this.holdCard();
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
          <button type="button" role="radio" data-mode="pinned" title="Pinned: the session beside the column, the last run on top">${icon('pin')}Pinned</button>
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
    // A run on its own replaces the last run's blue; a batch adds up.
    if (!run.batch) this.unseen.clear();
    const added = receipt.rows.filter((row) => row.mark === '+').map((row) => row.name);
    for (const name of added) this.unseen.add(name);
    const peek = !this.docked && this.mode === 'peek' && !run.batch && run.ok;
    const late = peek && !this.hasContent(receipt);
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
    this.unseen.clear();
    this.pending.clear();
    this.fresh = true;
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
    this.hideCard();
    this.paintPill();
    this.paintCard();
  }

  /** A cell's row was built: hang its chip. */
  decorate(id: string, row: HTMLElement): void {
    this.paintChip(id, row);
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
      this.placeCard();
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
    if (this.card?.kind === 'fresh' && this.card.id !== id) this.tuck();
    this.flightEnd?.();
    const previous = this.card?.id;
    this.card = { id, kind };
    clearTimeout(this.dwell);
    this.renderReceiptCard();
    this.receiptEl.hidden = false;
    this.receiptEl.classList.remove('show');
    this.placeCard();
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

  /** Beside the cell: past the chips' lane, its top on the cell's first
   *  line. A room too narrow for that lays it over its own right edge. */
  private placeCard() {
    if (!this.card) return;
    const row = this.docView.cellRow(this.card.id);
    if (!row || !row.isConnected || document.body.dataset.view) {
      this.hideCard();
      return;
    }
    const anchor = (row.querySelector('.cm-editor') ?? row).getBoundingClientRect();
    const room = this.room.getBoundingClientRect();
    const sheet = this.sheet.getBoundingClientRect();
    let left = sheet.right + CHIP_LANE;
    let width = Math.min(300, room.right - 12 - left);
    if (width < 220) {
      width = Math.min(290, room.width - 24);
      left = room.right - 12 - width;
    }
    const style = this.receiptEl.style;
    style.width = `${width}px`;
    this.receiptEl.classList.toggle('slim', width < 270);
    const height = this.receiptEl.offsetHeight;
    const top = Math.max(room.top + 10, Math.min(anchor.top, room.bottom - height - 10));
    style.left = `${left}px`;
    style.top = `${top}px`;
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
   *  pill, along a curve, shrinking; the pill's names update as it lands
   *  and the chip takes its place at the cell. */
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
    const from = card.getBoundingClientRect();
    const target = (this.names.getClientRects().length && this.names.getBoundingClientRect().width > 0 ? this.names : this.pill).getBoundingClientRect();
    const dx = target.left - from.left;
    const dy = target.top - from.top;
    const sx = Math.max(0.08, Math.min(1, target.width / from.width));
    const sy = Math.max(0.05, Math.min(1, target.height / from.height));
    // A quadratic curve that lifts first and then swings across into the
    // pill: the control point sits most of the way up, a little across.
    const cx = dx * 0.18;
    const cy = dy * 0.92;
    const frames: Keyframe[] = [];
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = 2 * (1 - t) * t * cx + t * t * dx;
      const y = 2 * (1 - t) * t * cy + t * t * dy;
      const grow = t ** 1.3;
      frames.push({
        transform: `translate(${x}px, ${y}px) scale(${1 + (sx - 1) * grow}, ${1 + (sy - 1) * grow})`,
        opacity: t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45 * 0.9,
        offset: t,
      });
    }
    card.classList.add('flying');
    document.body.classList.add('session-flying');
    const flight = card.animate(frames, { duration: FLY_MS, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' });
    const landTimer = window.setTimeout(land, FLY_MS * 0.72);
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

  /** p, or the card's pin: the receipt stays where it is until closed. */
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
    this.placeCard();
    if (this.card) this.paintChip(this.card.id);
  }

  /** Put the card away without the flight (a chip's, a held one, a cell
   *  gone): the chip shows again. */
  private hideCard(quiet = false) {
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
        if (this.card?.id === id) return;
        if (this.card?.kind === 'held') return;
        this.hoverTimer = window.setTimeout(() => {
          if (this.card?.kind === 'fresh') this.tuck();
          this.showCard(id, 'hover');
        }, 120);
      });
      chip.addEventListener('mouseleave', () => {
        clearTimeout(this.hoverTimer);
        if (this.card?.id === id && this.card.kind === 'hover') {
          this.hoverTimer = window.setTimeout(() => this.hideCard(), 180);
        }
      });
      chip.addEventListener('click', () => {
        clearTimeout(this.hoverTimer);
        if (this.card?.id === id && this.card.kind === 'held') this.hideCard();
        else {
          if (this.card?.id !== id) this.showCard(id, 'hover');
          this.holdCard();
        }
      });
      row.append(chip);
    }
    chip.className = `rchip kind-${kind}${receipt.past ? ' past' : ''}${this.card?.id === id ? ' on' : ''}`;
    chip.replaceChildren(kind === 'figure' ? printMark() : glyph(kind === 'table' ? 'table' : 'braces'), el('span', 'n', String(chipCount(receipt))));
    const named = receipt.rows.map((r) => r.name);
    chip.title = `${receipt.past ? 'Before the restart: ' : ''}${named.length ? named.join(', ') : 'a figure'} — hover for the receipt, click to keep it`;
    chip.setAttribute('aria-label', `Receipt of the last run: ${chip.title}`);
  }

  // ---------- the pill ----------

  private ordered(): string[] {
    return inCellOrder([...this.snapshot.keys()], this.owner, this.docView.cellIds(), this.receipts);
  }

  /** The kernel's status, then the names in cell order (new ones blue), or
   *  "empty session" / "fresh session" in words. `landing`: the names a
   *  receipt just brought home, lit for a moment. */
  private paintPill(landing?: string[]) {
    const ready = this.hooks.ready();
    this.pill.classList.toggle('ready', ready);
    this.pill.classList.toggle('open', this.visible);
    this.names.replaceChildren();
    if (!ready) {
      this.pill.title = 'The Python engine is not connected';
      return;
    }
    const names = this.ordered().filter((name) => !this.pending.has(name));
    if (!names.length) {
      this.names.append(el('span', 'sp-empty', this.fresh ? 'fresh session' : 'empty session'));
      this.pill.title = this.fresh ? 'A fresh session: run a cell to fill it' : 'Nothing in the session yet: run a cell';
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
    more.hidden = true;
    this.names.append(...spans, more);
    // Too many for the pill: the oldest names give way before the new ones.
    const order = [...spans.filter((s) => !s.classList.contains('new')).reverse(), ...spans.filter((s) => s.classList.contains('new')).reverse()];
    let hidden = 0;
    while (this.names.scrollWidth > this.names.clientWidth + 1 && hidden < order.length - 1) {
      order[hidden].hidden = true;
      hidden += 1;
      more.hidden = false;
      more.textContent = `+${hidden}`;
    }
    const figures = names.filter((name) => this.snapshot.get(name)?.figure).length;
    this.pill.title = `The session: ${names.length} name${names.length === 1 ? '' : 's'}${figures ? `, ${figures} figure${figures === 1 ? '' : 's'}` : ''} — click to ${this.visible ? 'close' : 'open'} it`;
    if (landing && this.mode === 'peek') {
      this.pill.classList.remove('got');
      void this.pill.offsetWidth;
      this.pill.classList.add('got');
    }
  }

  // ---------- the Session card ----------

  private get visible(): boolean {
    return this.docked || this.floating;
  }

  private toggleCard() {
    if (this.visible) this.closeCard();
    else this.openFloating();
  }

  private openFloating() {
    this.floating = true;
    this.showSessionCard(true);
  }

  private showSessionCard(animate = false) {
    if (this.tab === 'session') this.unseen.clear();
    this.cardEl.hidden = false;
    this.paintCard();
    this.layoutCard();
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
    this.paintToggle();
    this.paintPill();
  }

  private setDocked(on: boolean) {
    this.docked = on;
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
      this.showSessionCard();
      return;
    }
    this.mode = mode;
    writeStore(() => localStorage, MODE_KEY, mode);
    if (this.docked) {
      this.setDocked(false);
      this.floating = true;
    }
    this.paintCard();
    this.layoutCard();
  }

  private paintToggle() {
    this.toggle.setAttribute('aria-pressed', String(this.visible));
  }

  /** Floating: from the pill, at the room's top right. Docked: beside the
   *  column past the chips' lane, as far as the room goes; a room too
   *  narrow for that lays it over its own right edge (the column keeps its
   *  width either way). */
  private layoutCard() {
    if (this.cardEl.hidden) return;
    const room = this.room.getBoundingClientRect();
    const style = this.cardEl.style;
    let left: number;
    let width: number;
    let top: number;
    let height: number;
    if (this.docked) {
      const sheet = this.sheet.getBoundingClientRect();
      left = sheet.right + CHIP_LANE;
      width = Math.min(380, room.right - 10 - left);
      if (width < 220) {
        width = Math.min(320, room.width - 20);
        left = room.right - 10 - width;
      }
      top = room.top + 12;
      height = room.height - 24;
    } else {
      width = Math.min(380, room.width - 20);
      left = room.right - 10 - width;
      top = room.top + 10;
      height = room.height - 20;
    }
    style.left = `${left}px`;
    style.top = `${top}px`;
    style.width = `${width}px`;
    style.maxHeight = `${Math.max(160, height)}px`;
    this.cardEl.classList.toggle('docked', this.docked);
    this.cardEl.classList.toggle('floating', !this.docked);
    this.cardEl.classList.toggle('narrow', width < 300);
  }

  private showTab(tab: Tab) {
    this.tab = tab;
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

  /** Every name with its kind, type and preview, the last run's receipt on
   *  top. */
  private paintSessionPane() {
    const pane = this.panes.session;
    clearSafeSvgImages(pane);
    const receipt = this.last ? this.receipts.get(this.last) : undefined;
    if (receipt && !receipt.past) {
      const block = this.receiptView(receipt, 'session');
      // A run landing in the docked card lights it once; a repaint while
      // the light fades (the snapshot arriving) carries on where it was.
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
      }
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
    this.dataName = name;
    this.tab = 'data';
    if (!this.visible) this.openFloating();
    this.paintCard();
    await this.data.open(name);
    if (this.data.showing !== name) this.dataName = null;
    this.paintCard();
  }

  private async openFigure(ref: FigureRef, chosen = false) {
    this.figure = ref;
    if (chosen && this.figWaiting) this.figWaiting = null;
    this.tab = 'figures';
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

  // ---------- the receipt, drawn (the card, a chip's card, the Session tab) ----------

  private receiptView(receipt: Receipt, context: CardKind | 'session'): HTMLElement {
    const box = el('div', 'rv');
    if (receipt.past) box.classList.add('past');
    const number = this.docView.cellNumber(receipt.id);
    const isLast = this.last === receipt.id;
    const head = el('div', 'r-head');
    head.append(el('i', `r-dot${isLast ? '' : ' grey'}`));
    // "Cell 2 · this run": the second half gives way on a narrow card.
    const when = context === 'session' ? 'last run'
      : receipt.past ? 'before the restart' : context === 'fresh' ? 'this run' : isLast ? 'last run' : 'earlier';
    const what = el('span', 't', `Cell ${number ?? '–'}`);
    what.append(el('span', 'sub', ` · ${when}`));
    if (!receipt.ok) what.append(' · failed');
    head.append(what);
    head.append(el('span', 'took', took(receipt.ms)));
    if (context === 'fresh' || context === 'held') {
      const pin = el('button', `hb${context === 'held' ? ' on' : ''}`);
      pin.type = 'button';
      pin.innerHTML = icon('pin');
      pin.title = context === 'held' ? 'Kept here until you close it' : 'Keep it here (p)';
      pin.addEventListener('click', () => this.holdCard());
      const close = el('button', 'hb', '✕');
      close.type = 'button';
      close.title = context === 'fresh' ? 'Put it away (Esc)' : 'Close (Esc)';
      close.addEventListener('click', () => (context === 'fresh' ? this.tuck() : this.hideCard()));
      head.append(pin, close);
    } else if (context === 'session' && number !== null) {
      const go = el('button', 'go');
      go.append(el('span', 'sub', 'go there '), '→');
      go.title = 'Go to the cell';
      go.type = 'button';
      go.addEventListener('click', () => this.docView.goToCell(receipt.id));
      head.append(go);
    }
    box.append(head);

    if (receipt.figures.length) {
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
      box.append(fig);
    }

    if (receipt.rows.length) {
      const table = el('table', 'r-vars');
      const body = el('tbody');
      for (const row of receipt.rows) {
        const tr = el('tr');
        const opens = isTabular(row.v) || !!row.v.figure;
        if (opens) tr.classList.add('viewable');
        if (row.v.scratch) tr.classList.add('scratch');
        const mark = el('td', `m${row.mark === '+' ? ' new' : ''}`, row.mark);
        mark.title = row.mark === '+' ? 'new: first bound by this run' : row.inPlace ? 'changed in place by this run' : 'rebound by this run';
        tr.append(mark, el('td', 'n', row.name), el('td', 'ty', typeLabel(row.v)), el('td', 'pv', row.v.preview));
        if (opens) {
          tr.title = isTabular(row.v) ? 'Open in the data viewer' : 'Show the figure';
          tr.addEventListener('click', () => (isTabular(row.v) ? void this.openTable(row.name) : void this.openFigure({ name: row.name }, true)));
        }
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

    const folder = folderLine(receipt);
    if ((folder.values.length || folder.figs.length) && !receipt.scratch) {
      const line = el('div', 'r-folder');
      if (this.hooks.hasFolder()) {
        line.append(el('b', '', 'to the folder'));
        if (folder.values.length) line.append(' · values.json: ', el('code', '', folder.values.join(', ')));
        for (const fig of folder.figs) line.append(' · ', el('code', '', fig));
      } else {
        line.append(el('b', '', 'no folder yet'), ' · values.json and figs/ wait for a save');
      }
      box.append(line);
    }

    if (context === 'fresh') box.append(el('div', 'r-hint', 'keep typing to put it away ↗ · esc · p keeps it'));
    return box;
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

    document.addEventListener('mousedown', (e) => {
      const target = e.target as Element;
      this.carriedAt = performance.now();
      if (this.card && !this.receiptEl.contains(target) && !target.closest?.('.rchip')) {
        if (this.card.kind === 'fresh') this.tuck();
        else if (this.card.kind === 'hover' || !target.closest?.('#session')) this.hideCard();
      }
      if (this.floating && !this.cardEl.contains(target) && !this.pill.contains(target) &&
        !this.toggle.contains(target) && !this.receiptEl.contains(target) && !target.closest?.('.tb-menu')) {
        this.closeCard();
      }
    }, true);

    let frame = 0;
    const reflow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        this.placeCard();
        this.layoutCard();
      });
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
    window.addEventListener('resize', reflow);
    new ResizeObserver(reflow).observe(this.doc);
    // Source and grid views have no cells to stand beside.
    new MutationObserver(() => {
      if (document.body.dataset.view) {
        this.hideCard(true);
        if (this.floating) this.closeCard();
      }
      reflow();
    }).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
  }
}
