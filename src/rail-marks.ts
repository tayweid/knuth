// Knuth's marks on the scroll rail (scroll-rail.ts, which is Plass's rail
// with this as its mark source): what a notebook shows when you see all of
// it at once. Read from the cells (DocumentView.railCells) and the session
// (what a cell's last run left), when the column settles and when a run
// starts or ends, never on a keystroke; each label is asked again when it
// shows, so a heading or a line retyped since reads as it is now.
//
//   - Headings in text cells, as dots by level, as Plass's are: a # heading
//     the title's 7 px, ## a section's 5, ### and deeper a subsection's 3.
//   - Each code cell (scratch cells too, which the receipt also numbers) as
//     a faint tick at its top, so the rail reads as the notebook's rhythm,
//     code and prose; red when its last run raised, pulsing while it runs.
//   - A figure under a cell as a filled square at the figure's top, and a
//     table as an open one, Plass's two squares. Knuth draws no tables in
//     its outputs (the readout is text), so a table is a run that left a
//     DataFrame or a 2-D array (the names its receipt draws the table
//     glyph for; a Series is a column, not a table), marked at the top of
//     the cell's readout, or with none at the cell's end (under its
//     figures, so the two squares of a cell that plots and leaves a table
//     stand apart).
//   - The cursor's cell as the blue bar, at the cell's top, under the
//     cell's own mark; in a text cell its label is the cell's first block
//     (its heading, else its first paragraph).
//
// The labels: a heading's words; a code cell's number as the receipt
// counts it ("Cell 3") and its first line, set as code; an errored cell's
// number and the last line of its traceback; a figure's or a table's cell.
// Cell zero (a script's body before its first marker) is "Cell 0"; folded
// to the package header, it is not drawn, and has no mark.

import type { DocumentView, RailCell } from './document-view.ts';
import type { MarkKind, RailSource, Said, SourceMark } from './scroll-rail.ts';

const LEVEL: Record<string, MarkKind> = { H1: 'title', H2: 'section' };

/** The first line with something on it, or what the cell is. */
const firstLine = (c: RailCell) => c.firstLine() || 'empty cell';

/** A traceback's last line: the exception and its message. */
function raised(c: RailCell): string {
  const lines = (c.output?.textContent ?? '').split('\n').filter((l) => l.trim() !== '');
  return lines.at(-1)?.trim() ?? 'raised';
}

/** A text cell's first block with words in it, for the cursor's bar: its
 *  heading's words when it opens with one, else its first paragraph (a
 *  list or a quote by its first item). Block by block: the editor's
 *  textContent runs a heading into the paragraph under it, and innerText
 *  would lay the column out. */
function prose(c: RailCell): string {
  let text = '';
  for (let el = c.prose?.firstElementChild ?? null; el && !text; el = el.nextElementSibling) {
    let block: Element = el;
    while (block.matches('ul, ol, blockquote') && block.firstElementChild) block = block.firstElementChild;
    text = (block.textContent ?? '').replace(/\s+/g, ' ').trim();
  }
  return text.slice(0, 120) || 'text cell';
}

/** Laid out, so it has a place: a folded or hidden row has none. */
const placed = (el: HTMLElement) => el.offsetParent !== null;

export function cellMarks(docView: DocumentView, tablesOf: (id: string) => string[]): RailSource {
  const cellName = (c: RailCell) => `Cell ${c.number}`;
  return {
    marks() {
      const out: SourceMark[] = [];
      for (const c of docView.railCells()) {
        if (!placed(c.row)) continue;
        if (c.kind === 'text') {
          // Each heading's own top: margins sit outside the box, so its
          // top is its text's.
          const headings = c.prose ? [...c.prose.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')] : [];
          headings.forEach((h, i) => {
            out.push({
              key: `${c.id}:h${i}`,
              kind: LEVEL[h.tagName] ?? 'subsection',
              el: h,
              say: (): Said => ({ k: '', t: h.textContent ?? '' }),
            });
          });
          continue;
        }
        const scratch = c.kind === 'scratch';
        out.push({
          key: `${c.id}:code`,
          kind: 'code',
          el: c.row,
          error: c.error,
          running: c.running,
          say: (): Said =>
            c.error
              ? { k: cellName(c), t: raised(c), err: true, code: true }
              : { k: cellName(c), t: firstLine(c), p: c.running ? 'running' : scratch ? 'scratch' : '', code: true },
        });
        c.figures.forEach((figure, i) => {
          out.push({
            key: `${c.id}:figure${i}`,
            kind: 'figure',
            el: figure,
            say: (): Said => ({ k: 'Figure', t: cellName(c), p: c.figures.length > 1 ? `${i + 1} of ${c.figures.length}` : '' }),
          });
        });
        const tables = tablesOf(c.id);
        if (tables.length) {
          out.push({
            key: `${c.id}:table`,
            kind: 'table',
            el: c.output ?? c.row,
            bottom: !c.output,
            say: (): Said => ({ k: 'Table', t: tables.join(', '), p: cellName(c), code: true }),
          });
        }
      }
      return out;
    },
    caret() {
      const id = docView.focusedId;
      const c = id ? docView.railCells().find((cell) => cell.id === id) : undefined;
      if (!c || !placed(c.row)) return null;
      return {
        key: 'caret',
        kind: 'caret',
        el: c.row,
        say: (): Said => (c.kind === 'text' ? { k: 'Cursor', t: prose(c) } : { k: 'Cursor', t: cellName(c) }),
      };
    },
  };
}
