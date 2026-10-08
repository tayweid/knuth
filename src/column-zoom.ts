// The column's zoom: Knuth.app's View › Zoom In / Zoom Out / Actual Size
// (⌘+ ⌘− ⌘0). The shell (0.2.11, app/knuth.json `zoom: "page"`) holds
// Chromium's zoom at 1, so the bar, the rail, the pill and the cards
// beside the column never change size, and tells the page a step
// (shell.ts, the `zoom` event). The step is the column's alone: its cells
// drawn larger (CSS `zoom` on #sheet's children, --column-zoom), its
// measure widened by as much (#sheet's 52rem and 40rem floor, styles.css),
// so a zoomed notebook rewraps like the same notebook on a larger screen,
// inside the same window. The session lays its cards beside the column
// from the same factor (session.ts, columnAt). One zoom for the app,
// remembered.

/** Chromium's own steps, from half size to three times. */
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const KEY = 'knuth-column-zoom';

let zoom = read();
const listeners = new Set<() => void>();

function read(): number {
  try {
    const stored = Number(localStorage.getItem(KEY));
    return ZOOMS.includes(stored) ? stored : 1;
  } catch {
    return 1;
  }
}

function paint(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (zoom === 1) root.style.removeProperty('--column-zoom');
  else root.style.setProperty('--column-zoom', String(zoom));
}

paint();

/** The column's zoom (1: the 52rem measure at its own size). */
export function columnZoom(): number {
  return zoom;
}

/** Called after every change of the zoom, once the column has it. */
export function onColumnZoom(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One step: 1 in, -1 out, 0 back to the column's own size. Answers the
 *  zoom it is at now, the same one at either end of the steps. The room
 *  keeps its place: the same fraction of the column at its top. */
export function zoomColumn(step: 1 | -1 | 0, scroller: HTMLElement): number {
  const at = ZOOMS.indexOf(zoom);
  const next = step === 0 ? 1 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, at + step))];
  if (next === zoom) return zoom;
  const place = scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;
  zoom = next;
  try {
    localStorage.setItem(KEY, String(zoom));
  } catch {
    // A page without storage zooms all the same, for this window.
  }
  paint();
  scroller.scrollTop = place * scroller.scrollHeight;
  for (const listener of listeners) listener();
  return zoom;
}
