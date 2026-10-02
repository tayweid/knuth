// The scroll rail: the whole document, top to bottom, in a 20 px gutter of
// the frame at the window's right, outside the room, as the history view's
// strip lives beside its river (the shell's history.html, #mini). This is
// Plass's src/scroll-rail.ts (plass ux/rail at 7f0b47e; eddd06c after it
// moved only the page numbers, which Knuth has none of) with Knuth's mark
// source: the track, the band, the hover label, the drag, the wheel and the
// keyboard are Plass's, in Plass's order and under Plass's names, so a fix
// in one can be carried to the other; what the marks are and where they
// stand comes from rail-marks.ts, which reads the cells (DocumentView) and
// the session. Taylor, 2026-10-02, after Plass's landed: "would it be easy
// to add a scroll rail similar to plass for knuth?" The names keep
// Plass's: `panel` is the room's scroller (#doc, Plass's #scroll) and
// `stack` the column (#sheet, Plass's #stack).
//
// One fraction maps everything. A point of the document, y in the room's
// scroll px (the column's own layout, the room's top padding above it and
// its 40vh below), is y / the room's scroll height down the track, and the
// track is exactly the room's height. The marks are placed by that
// fraction in CSS (`top: calc(var(--f) * 100%)`), and the band, the visible
// span, is the room's scrollTop and clientHeight over the same height, so
// the two agree by construction. The band is drawn on its own layer: a
// scroll writes its offset, a transform, in a frame (and its height, only
// when the room's scroll range or size changed), and the marks inside it
// carry the class `in` (a step brighter), set only on those that crossed
// the band's edges since the last frame, usually none. Nothing a scroll
// writes is inherited by the marks or lays the rail out.
//
// What differs from Plass, and why. Plass's paper is laid out once at
// 816 px and drawn to the panel's width by a transform, so a resize moves
// no mark there; Knuth's column reflows (a narrower window wraps its
// lines), and a cell grows as its output arrives, so the marks are read
// again whenever the column or the room changes size (one ResizeObserver
// on both, coalesced into a frame) and when a run starts or ends, which
// changes a tick's colour without changing a size. Never on a scroll, and
// a keystroke writes nothing unless it changes the column's height (a new
// line), which is the column settling. Knuth has no pages, so Plass's page
// breaks, their numbers and the numbers' crowding rule are not here;
// instead the code cells' ticks thin on a long notebook (TICK_ROOM). A mark
// is reused across reads by its key, so the focus and the hover survive
// the column settling under them.
//
// The gutter is there while the column runs past the room in the cell view
// (its last cell's end below the room's bottom at the top of the scroll):
// a document that fits, and the source and grid views, keep the frame's
// 8 px edge. The gutter takes 12 px from the room, whose column keeps its
// own width rules (at the usual widths it is the 52rem measure either way;
// only the margins change). The room draws no scrollbar of its own in the
// cell view (styles.css), so the gutter's 12 px only ever narrow what the
// column can have, and a narrower column is never shorter: the gutter
// cannot take itself away. It comes and goes at once, not animated. Nothing
// opens or grows while a mouse button is down: a gutter due then waits for
// the button to come up, and a press that began on the text (a selection
// dragged toward the edge) wakes nothing on the rail.

/** px either side of a mark, in the rail, within which the pointer takes it. */
const HIT = 7;
/** px a press moves before it is a drag (a scrub) and not a click. */
const DRAG = 3;
/** A code cell's tick this near (track px) the last tick drawn is not
 *  drawn (it stays a target): a long notebook's rail reads as its rhythm
 *  rather than fur. Plass thins its page hairlines under 4 px a page. A
 *  tick that ran or raised is always drawn. */
const TICK_ROOM = 4;
/** How long the band stays lit after the document moves, and after the
 *  pointer leaves the gutter. */
const MOVING_MS = 900;
const SLEEP_MS = 600;

export type MarkKind = 'title' | 'section' | 'subsection' | 'code' | 'figure' | 'table' | 'caret';

/** A mark's label: its lead (a cell's number, "Figure"), its words, and a
 *  quiet end; the words set as code (a cell's line, a table's names) or as
 *  an error. */
export interface Said {
  k: string;
  t: string;
  p?: string;
  code?: boolean;
  err?: boolean;
}

/** What a mark source hands the rail for each mark (rail-marks.ts). */
export interface SourceMark {
  /** Stable across reads, so the mark's button is reused. */
  key: string;
  kind: MarkKind;
  /** The element whose top (or, `bottom`, bottom) the mark stands for. */
  el: HTMLElement;
  bottom?: boolean;
  /** A code cell's last run raised; a code cell is running. */
  error?: boolean;
  running?: boolean;
  /** The label, asked when it shows (and for the button's name), so words
   *  typed since the marks were read are the label's. */
  say(): Said;
}

export interface RailSource {
  /** Every mark, in document order. */
  marks(): SourceMark[];
  /** The cell the cursor is in, or null. */
  caret(): SourceMark | null;
}

interface Mark {
  kind: MarkKind;
  key: string;
  src: SourceMark;
  /** The room's scroll px, and that over the room's scroll height (its --f). */
  y: number;
  f: number;
  /** Inside the band (its class `in`), as last drawn. */
  inside: boolean;
  button: HTMLButtonElement;
}

type Target = Mark;

export interface ScrollRail {
  /** A cell started or finished a run: read the marks again (a tick's
   *  colour, its pulse, a table its receipt names). */
  cells(): void;
  /** The cursor moved to another cell: move its bar. */
  selection(): void;
  /** The source or grid view opened (true), or the cells came back. */
  mode(away: boolean): void;
}

/** The caret's bar is drawn under the cell's own mark (styles.css), and
 *  sorted after it, so a tie at the cell's top goes to the cell. */
const CLASSES: Record<MarkKind, string> = {
  title: 'sr-title',
  section: 'sr-section',
  subsection: 'sr-subsection',
  code: 'sr-code',
  figure: 'sr-figure',
  table: 'sr-table',
  caret: 'sr-caret',
};

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

/** An element's top in the room's scroll px: its box against the room's,
 *  plus the room's scroll. (Plass walks offsetTop to its stack; the cells
 *  here are positioned boxes inside an unpositioned scroller, so the chain
 *  would skip the room.) */
function layoutTop(el: HTMLElement, panel: HTMLElement): number {
  return el.getBoundingClientRect().top - panel.getBoundingClientRect().top - panel.clientTop + panel.scrollTop;
}

const words = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Down the track; at the same place, the cursor's bar after the cell's
 *  own mark, so a tie at a cell's top is the cell's. */
const order = (a: Mark, b: Mark) => a.y - b.y || Number(a.kind === 'caret') - Number(b.kind === 'caret');

function named(s: Said): string {
  return [s.k, s.t, s.p].filter(Boolean).join(', ');
}

export function attachScrollRail(source: RailSource, panel: HTMLElement, stack: HTMLElement): ScrollRail {
  const root = document.documentElement;
  const rail = make('nav', '');
  rail.id = 'scrollrail';
  rail.setAttribute('aria-label', 'Document map');
  const track = make('div', 'sr-track');
  const band = make('div', 'sr-band');
  const ghost = make('div', 'sr-ghost');
  band.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('aria-hidden', 'true');
  track.append(band, ghost);
  rail.append(track);
  // The label hangs to the rail's left over the room's right margin, fixed
  // to the window: the gutter has no room for it.
  const label = make('div', '');
  label.id = 'sr-label';
  label.setAttribute('role', 'tooltip');
  label.setAttribute('aria-hidden', 'true');
  document.body.append(rail, label);

  let docH = 1;
  let marks: Mark[] = [];
  let caret: Mark | null = null;
  const byKey = new Map<string, Mark>();
  let on = false;
  let away = false;
  let trackH = 1;
  let frame = 0;
  let bandFrame = 0;
  let caretFrame = 0;

  const fraction = (y: number) => y / docH;
  /** Where a mark stands, in the room's scroll px. */
  const placeOf = (src: SourceMark) => layoutTop(src.el, panel) + (src.bottom ? src.el.offsetHeight : 0);
  const inTrack = (y: number) => fraction(y) * trackH;
  const fmt = (f: number) => String(Math.round(Math.max(0, Math.min(1, f)) * 1e6) / 1e6);

  /* ---------- the gutter: there or not ---------- */

  function wanted(): boolean {
    if (away) return false;
    // The column's end at the top of the scroll, against the room's
    // height: the room's 40vh under the column is room to type into, not
    // document, so a column that fits keeps the 8 px edge.
    return layoutTop(stack, panel) + stack.offsetHeight > panel.clientHeight + 1;
  }

  let pressed = false;
  let pending = false;
  function refresh(): void {
    frame = 0;
    const want = wanted();
    if (want !== on) {
      // A gutter that came or went under a held button would move the
      // column under a selection being dragged: it waits for the release.
      if (pressed) pending = true;
      else {
        on = want;
        root.classList.toggle('has-rail', on);
        if (!on) {
          unhot();
          rail.classList.remove('awake', 'moving', 'dragging');
        }
      }
    }
    if (!on) return;
    build();
    layoutRail();
  }
  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(refresh);
  }
  window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') pressed = true; }, true);
  const release = () => {
    pressed = false;
    if (pending) {
      pending = false;
      schedule();
    }
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);
  window.addEventListener('resize', schedule);

  /* ---------- the marks, read when the column settles ---------- */

  function markFor(src: SourceMark): Mark {
    let m = byKey.get(src.key);
    if (m) m.src = src;
    else {
      const button = make('button', `sr-mark ${CLASSES[src.kind]}`);
      button.type = 'button';
      button.tabIndex = -1;
      m = { kind: src.kind, key: src.key, src, y: 0, f: 0, inside: false, button };
      const mark = m;
      // Enter or Space on the focused mark (the pointer is the rail's own,
      // below: the marks take no pointer events).
      button.addEventListener('click', () => jump(mark));
      button.addEventListener('focus', () => hot(mark));
      byKey.set(src.key, m);
      track.append(button);
    }
    m.y = placeOf(src);
    m.f = fraction(m.y);
    const f = fmt(m.f);
    if (m.button.style.getPropertyValue('--f') !== f) m.button.style.setProperty('--f', f);
    m.button.classList.toggle('error', !!src.error);
    m.button.classList.toggle('running', !!src.running);
    const name = named(src.say());
    if (m.button.getAttribute('aria-label') !== name) m.button.setAttribute('aria-label', name);
    return m;
  }

  function build(): void {
    docH = panel.scrollHeight || 1;
    const focused = marks.findIndex((m) => m.button === document.activeElement);
    const stop = marks.find((m) => m.button.tabIndex === 0) ?? null;
    const next: Mark[] = source.marks().map(markFor);
    const place = source.caret();
    caret = place ? markFor({ ...place, key: 'caret', kind: 'caret' }) : null;
    if (caret) next.push(caret);
    // Gone: the cell was deleted, its figure redrawn as fewer, the view
    // switched. A gone mark under the pointer puts its label away.
    const kept = new Set(next);
    for (const [key, m] of byKey) {
      if (kept.has(m)) continue;
      if (current === m) unhot();
      m.button.remove();
      byKey.delete(key);
    }
    // Stable, so a tie keeps document order (a heading before the cell
    // under it), and the caret loses one.
    marks = next.sort(order);
    // One tab stop: the one there was, else the first mark; the focus, if a
    // mark had it and it went, to the mark now at its place. Written only
    // where it changes: the column settling rewrites no mark it did not
    // move.
    const keep = stop && kept.has(stop) ? stop : marks[Math.min(Math.max(focused, 0), marks.length - 1)];
    for (const m of marks) {
      const tab = m === keep ? 0 : -1;
      if (m.button.tabIndex !== tab) m.button.tabIndex = tab;
    }
    if (keep && focused >= 0 && document.activeElement === document.body) keep.button.focus({ preventScroll: true });
    if (current) showLabel(current);
  }

  function placeCaret(): void {
    caretFrame = 0;
    if (!on) return;
    const place = source.caret();
    const had = caret;
    caret = place ? markFor({ ...place, key: 'caret', kind: 'caret' }) : null;
    if (had && !caret) {
      if (current === had) unhot();
      had.button.remove();
      byKey.delete('caret');
      marks = marks.filter((m) => m !== had);
    } else if (caret && !had) marks.push(caret);
    if (!caret) return;
    light(caret);
    marks.sort(order);
    if (current === caret) showLabel(caret);
  }

  /* ---------- the track's px: on a rebuild and a resize ---------- */

  function layoutRail(): void {
    // Fractional: under a zoom step the track is not a whole number of px.
    trackH = track.getBoundingClientRect().height || 1;
    // A code tick within TICK_ROOM of the last one drawn is left undrawn;
    // one that ran or raised, and every other kind, is always drawn.
    let last = -Infinity;
    for (const m of marks) {
      if (m.kind !== 'code') continue;
      const at = inTrack(m.y);
      const loud = !!(m.src.error || m.src.running);
      const thin = !loud && at - last < TICK_ROOM;
      if (m.button.classList.contains('thin') !== thin) m.button.classList.toggle('thin', thin);
      if (!thin) last = at;
    }
    drawBand();
  }

  /* ---------- the band: the visible span, after a scroll ---------- */

  let span0 = 0;
  let span1 = 1;
  /** A mark inside the band carries `in`: written only when that changes,
   *  so a scroll touches the few that crossed the band's edges. */
  function light(t: Target): void {
    const now = t.f >= span0 && t.f <= span1;
    if (now === t.inside) return;
    t.inside = now;
    t.button.classList.toggle('in', now);
  }

  /** The band's height and offset as last written: a scroll moves it and
   *  rewrites only the offset, a transform on the band's own layer, so the
   *  frame neither lays out nor paints the rail. */
  let bandH = '';
  let bandY = '';
  const px = (v: number) => `${Math.round(v * 100) / 100}px`;

  function drawBand(): void {
    bandFrame = 0;
    const H = panel.scrollHeight || 1;
    const top = panel.scrollTop;
    span0 = top / H;
    span1 = (top + panel.clientHeight) / H;
    // Never under 10 px tall, never past the track's ends.
    const h = Math.max(10, (span1 - span0) * trackH);
    const height = px(h);
    const y = `translateY(${px(Math.min(Math.max(0, span0 * trackH), trackH - h))})`;
    if (height !== bandH) band.style.height = bandH = height;
    if (y !== bandY) band.style.transform = bandY = y;
    for (const m of marks) light(m);
  }

  let moving = false;
  let movingTimer = 0;
  panel.addEventListener(
    'scroll',
    () => {
      if (!on) return;
      if (!bandFrame) bandFrame = requestAnimationFrame(drawBand);
      if (!moving) {
        moving = true;
        rail.classList.add('moving');
      }
      clearTimeout(movingTimer);
      movingTimer = window.setTimeout(() => {
        moving = false;
        rail.classList.remove('moving');
      }, MOVING_MS);
    },
    { passive: true },
  );

  // The column settling: a cell's output arriving, a figure loading, a
  // cell added or removed, a line typed, the column rewrapping at a new
  // width; and the room's own size (the window, the gutter coming or
  // going, the 40vh under the column with the window's height). One
  // observer for both, coalesced into the frame's refresh, which reads the
  // marks again. Plass observes only its panel (its marks come from the
  // settled layout pass, and a resize changes only the drawing).
  const settled = new ResizeObserver(schedule);
  settled.observe(stack);
  settled.observe(panel);

  /* ---------- hover: the nearest mark, and its label ---------- */

  let current: Target | null = null;

  function nearest(y: number): Target | null {
    let best: Target | null = null;
    let bd = HIT;
    for (const m of marks) {
      const d = Math.abs(inTrack(m.y) - y);
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    return best;
  }

  function span(className: string, text: string): HTMLSpanElement {
    const s = make('span', className);
    s.textContent = text;
    return s;
  }

  /** Level with `y` (track px), and never cut by the window's edge. */
  function placeLabel(y: number): void {
    const r = track.getBoundingClientRect();
    const half = label.offsetHeight / 2;
    label.style.top = `${Math.min(innerHeight - half - 4, Math.max(half + 4, r.top + y))}px`;
  }

  function showLabel(m: Target): void {
    const s = m.src.say();
    label.className = s.code ? 'show code' : 'show';
    label.replaceChildren(
      ...(s.k ? [span('k', s.k)] : []),
      span(s.err ? 't err' : 't', words(s.t)),
      ...(s.p ? [span('p', s.p)] : []),
    );
    placeLabel(inTrack(m.y));
  }

  function hot(m: Target): void {
    if (current === m) return;
    unhot();
    current = m;
    ghost.classList.remove('show');
    m.button.classList.add('hot');
    showLabel(m);
  }

  function unhot(): void {
    if (current) current.button.classList.remove('hot');
    current = null;
    label.classList.remove('show');
  }

  /** Empty track: a faint line where a click would land, and what is
   *  there (the cell or the section that point is in). */
  function ghostAt(y: number): void {
    unhot();
    const f = Math.max(0, Math.min(1, y / trackH));
    ghost.style.top = `${f * 100}%`;
    ghost.classList.add('show');
    let under: Mark | null = null;
    for (const m of marks) {
      if (m.f > f) break;
      if (m.kind !== 'caret' && m.kind !== 'figure' && m.kind !== 'table') under = m;
    }
    const s = under?.src.say();
    label.className = 'quiet show';
    label.replaceChildren(span('t', s ? (s.k && under!.kind === 'code' ? s.k : words(s.t)) : 'Top'));
    placeLabel(f * trackH);
  }

  function rest(): void {
    unhot();
    ghost.classList.remove('show');
  }

  /* ---------- awake: the band lit while the pointer is in the gutter ---------- */

  let sleepTimer = 0;
  function wake(): void {
    clearTimeout(sleepTimer);
    rail.classList.add('awake');
  }
  function sleep(): void {
    clearTimeout(sleepTimer);
    sleepTimer = window.setTimeout(() => rail.classList.remove('awake'), SLEEP_MS);
  }

  /* ---------- jumps and the drag ---------- */

  const smooth = (): ScrollBehavior => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

  // A cell, a heading, a figure, a table or the cursor's cell lands an
  // eighth of the way down the room, as a heading reached from a contents
  // list does; its place is read again at the click, in case the column
  // moved since the marks were read. Knuth's alone: a code cell far from
  // the screen is laid out from CodeMirror's estimate of its lines and is
  // measured as it comes into view (a few px, more for long wrapped
  // lines), which moves what is under it while the scroll is on its way;
  // at the scroll's end the target is read once more and the scroll put
  // right, at once. A wheel, a press or a key before then cancels that.
  let landing: Target | null = null;
  const target = (m: Target) => Math.min(Math.max(0, placeOf(m.src) - panel.clientHeight / 8), panel.scrollHeight - panel.clientHeight);
  function jump(m: Target): void {
    const top = target(m);
    landing = Math.abs(top - panel.scrollTop) > 1 ? m : null;
    panel.scrollTo({ top, behavior: smooth() });
  }
  panel.addEventListener('scrollend', () => {
    const m = landing;
    landing = null;
    if (!m || !m.button.isConnected) return;
    const top = target(m);
    if (Math.abs(top - panel.scrollTop) > 1) panel.scrollTo({ top });
  });
  const cancelLanding = () => (landing = null);
  panel.addEventListener('wheel', cancelLanding, { passive: true });
  window.addEventListener('pointerdown', cancelLanding, true);
  window.addEventListener('keydown', cancelLanding, true);

  /** Empty track: that point of the document in the middle of the room. */
  function centre(y: number): void {
    const top = (y / trackH) * panel.scrollHeight - panel.clientHeight / 2;
    panel.scrollTo({ top: Math.max(0, top), behavior: smooth() });
  }

  const yIn = (e: PointerEvent) => e.clientY - track.getBoundingClientRect().top;
  let drag: { y0: number; top0: number; y: number; moved: boolean; target: Target | null } | null = null;

  rail.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // The press is the rail's: the cell keeps the focus and the cursor.
    e.preventDefault();
    rail.setPointerCapture(e.pointerId);
    const y = yIn(e);
    drag = { y0: e.clientY, top0: panel.scrollTop, y, moved: false, target: nearest(y) };
    wake();
    rail.classList.add('dragging');
  });

  rail.addEventListener('pointermove', (e) => {
    if (drag) {
      // A press that moves scrubs the band from where it was, wherever it
      // was pressed (on a mark, on the band, on empty track), and jumps
      // nothing: the document follows the pointer by the track's
      // proportion.
      if (!drag.moved && Math.abs(e.clientY - drag.y0) > DRAG) {
        drag.moved = true;
        rest();
      }
      if (drag.moved) panel.scrollTop = drag.top0 + ((e.clientY - drag.y0) / trackH) * panel.scrollHeight;
      return;
    }
    // A button held from elsewhere (a selection dragged toward the edge):
    // nothing on the rail opens or grows.
    if (e.buttons) {
      rest();
      return;
    }
    wake();
    const y = yIn(e);
    const m = nearest(y);
    if (m) hot(m);
    else ghostAt(y);
  });

  const endDrag = (e: PointerEvent) => {
    const d = drag;
    if (!d) return;
    drag = null;
    rail.classList.remove('dragging');
    if (e.type === 'pointercancel' || d.moved) return;
    if (d.target) jump(d.target);
    else {
      // A click on the band itself is a grab that never moved: it stays.
      const f0 = panel.scrollTop / panel.scrollHeight;
      const f1 = (panel.scrollTop + panel.clientHeight) / panel.scrollHeight;
      const f = d.y / trackH;
      if (f < f0 || f > f1) centre(d.y);
    }
  };
  rail.addEventListener('pointerup', endDrag);
  rail.addEventListener('pointercancel', endDrag);
  rail.addEventListener('pointerleave', () => {
    if (drag) return;
    rest();
    sleep();
  });

  // The gutter is outside the scrolling room, so a wheel over it would
  // scroll nothing: it goes to the room, in lines or pages as it came.
  rail.addEventListener(
    'wheel',
    (e) => {
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? panel.clientHeight : 1;
      panel.scrollBy(0, e.deltaY * k);
    },
    { passive: true },
  );

  // Keys: one tab stop, Up and Down between marks (the label follows),
  // Home and End, Return or Space jumps (the button's own click).
  rail.addEventListener('keydown', (e) => {
    const i = marks.findIndex((m) => m.button === document.activeElement);
    if (i < 0) return;
    let j = i;
    if (e.key === 'ArrowDown') j = Math.min(marks.length - 1, i + 1);
    else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = marks.length - 1;
    else return;
    e.preventDefault();
    marks[i].button.tabIndex = -1;
    marks[j].button.tabIndex = 0;
    marks[j].button.focus();
  });
  rail.addEventListener('focusout', (e) => {
    if (!rail.contains(e.relatedTarget as Node | null)) unhot();
  });

  return {
    cells() {
      schedule();
    },
    selection() {
      if (on && !caretFrame) caretFrame = requestAnimationFrame(placeCaret);
    },
    mode(active) {
      away = active;
      schedule();
    },
  };
}
