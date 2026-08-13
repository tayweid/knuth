// Percent-format (.py) document model: parse/serialize with byte-identical
// round-tripping. Syntax decisions (recorded in DESIGN.md):
//   - Cells open with "# %%" ("#%%" tolerated, marker preserved verbatim).
//     "# %% [markdown]" is a text cell; "# %% scratch" (exact token) is a
//     scratch cell; any other suffix (titles, tags=...) is a program cell,
//     so jupytext/VS Code/Spyder files parse unchanged.
//   - Outputs are machine-managed comment lines prefixed "#->" forming the
//     trailing run in their cell — no start/end delimiters. Blank output
//     lines are bare "#->". Figures are referenced by path, never embedded.

export type CellKind = 'program' | 'scratch' | 'text';

export interface Cell {
  kind: CellKind;
  /** Raw marker line, preserved verbatim ("# %%", "#%% title", ...). */
  marker: string;
  /** Raw body lines above the output block. */
  source: string[];
  /** Raw "#->" output lines (machine-managed). */
  output: string[];
  /** Raw blank lines between the output block and the next cell. */
  trailing: string[];
}

export interface KnuthDocument {
  /** Raw lines before the first marker (shebang, jupytext header, plain scripts). */
  preamble: string[];
  cells: Cell[];
  /** Whether the file ends with a newline. */
  trailingNewline: boolean;
}

const MARKER = /^# ?%%(.*)$/;
const OUTPUT_PREFIX = '#->';

function cellKind(markerRest: string): CellKind {
  const rest = markerRest.trim();
  if (rest.startsWith('[markdown]')) return 'text';
  if (rest === 'scratch') return 'scratch';
  return 'program';
}

function splitBody(body: string[]): Pick<Cell, 'source' | 'output' | 'trailing'> {
  let end = body.length;
  while (end > 0 && body[end - 1].trim() === '') end--;
  let start = end;
  while (start > 0 && body[start - 1].startsWith(OUTPUT_PREFIX)) start--;
  if (start === end) return { source: body, output: [], trailing: [] };
  return {
    source: body.slice(0, start),
    output: body.slice(start, end),
    trailing: body.slice(end),
  };
}

export function parseDocument(text: string): KnuthDocument {
  if (text === '') return { preamble: [], cells: [], trailingNewline: false };
  const lines = text.split('\n');
  const trailingNewline = lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();

  const preamble: string[] = [];
  const cells: Cell[] = [];
  let current: { marker: string; rest: string; body: string[] } | null = null;

  const close = () => {
    if (!current) return;
    cells.push({
      kind: cellKind(current.rest),
      marker: current.marker,
      ...splitBody(current.body),
    });
  };

  for (const line of lines) {
    const m = MARKER.exec(line);
    if (m) {
      close();
      current = { marker: line, rest: m[1], body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  close();
  return { preamble, cells, trailingNewline };
}

export function serializeDocument(doc: KnuthDocument): string {
  const lines = [
    ...doc.preamble,
    ...doc.cells.flatMap((c) => [c.marker, ...c.source, ...c.output, ...c.trailing]),
  ];
  if (lines.length === 0) return '';
  return lines.join('\n') + (doc.trailingNewline ? '\n' : '');
}

/** Code text of a program/scratch cell. */
export function cellCode(cell: Cell): string {
  return cell.source.join('\n');
}

/** Prose of a text cell, comment prefix stripped. */
export function textProse(cell: Cell): string {
  return cell.source.map((l) => l.replace(/^# ?/, '')).join('\n');
}

/** Replace a text cell's prose (canonical "# " prefixing, blank lines as "#"). */
export function setProse(cell: Cell, prose: string): void {
  cell.source = prose === '' ? [] : prose.split('\n').map((l) => (l === '' ? '#' : `# ${l}`));
}

/** Output block content, "#->" prefix stripped. */
export function outputText(cell: Cell): string {
  return cell.output.map((l) => l.replace(/^#-> ?/, '')).join('\n');
}

/**
 * Replace a cell's output block (canonical "#-> " prefixing); null clears it.
 * Blank separator lines between cells stay put in either direction.
 */
export function setOutput(cell: Cell, text: string | null): void {
  if (text === null) {
    cell.output = [];
    cell.source.push(...cell.trailing);
    cell.trailing = [];
    return;
  }
  if (cell.output.length === 0) {
    let end = cell.source.length;
    while (end > 0 && cell.source[end - 1].trim() === '') end--;
    cell.trailing = cell.source.slice(end);
    cell.source = cell.source.slice(0, end);
  }
  cell.output = text.split('\n').map((l) => (l === '' ? OUTPUT_PREFIX : `${OUTPUT_PREFIX} ${l}`));
}
