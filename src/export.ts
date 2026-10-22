// Export to Markdown (Taylor, 2026-10-21: "a knuth export to markdown or
// pdf to create a plass like document, but without the code being
// visible … r studio has something like this with rmarkdown"). The
// document as a reader sees it, in the Pandoc Markdown Plass opens
// (plass/docs/MARKDOWN-FORMAT.md), so Plass makes the PDF:
//
// - the text cells, as written (their math is already Plass's $…$);
// - a first `# Title` heading becomes the front matter's title, as an
//   R Markdown document's YAML holds it;
// - each code cell's figures, embedded as SVG data URLs, so the export is
//   one file that opens anywhere with nothing to grant or keep beside it;
// - a code cell that ends by showing a table by name (`prices`) gets a
//   pipe table of its first rows;
// - no code, no printed output, no scratch cells, no cell zero.
//
// Pure: main.ts gathers the cells, their figures and tables, and writes
// the text where the document lives (FileManager.writeBeside).

export interface ExportTable {
  columns: string[];
  index: string[];
  rows: string[][];
  /** The table's whole length, when more rows exist than are shown. */
  total: number;
}

export type ExportCell =
  | { kind: 'text'; prose: string }
  | { kind: 'program'; code: string; figures: string[]; table?: ExportTable | null };

/** The rows of a table an export shows; the rest are counted. */
export const TABLE_ROWS = 30;

/** The name a code cell ends by showing, if its last line is a bare name:
 *  `prices`, not `prices.head()` or `x = prices`. */
export function shownName(code: string): string | null {
  const lines = code.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const last = lines.at(-1);
  return last && /^[A-Za-z_][A-Za-z0-9_]*$/.test(last) && !KEYWORDS.has(last) ? last : null;
}

const KEYWORDS = new Set(['pass', 'break', 'continue', 'return', 'None', 'True', 'False']);

/** An SVG as a data URL Plass reads (UTF-8, base64). */
export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** A pipe table: the index first, numbers right-aligned, `|` escaped. */
export function pipeTable(table: ExportTable): string {
  const cell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
  const numeric = (i: number) => table.rows.length > 0 && table.rows.every((row) => /^[-+]?(\d[\d,]*\.?\d*|\.\d+)(e[-+]?\d+)?%?$|^nan$/i.test((row[i] ?? '').trim()));
  const head = ['', ...table.columns].map(cell);
  const rule = [':--', ...table.columns.map((_, i) => (numeric(i) ? '--:' : ':--'))];
  const body = table.rows.map((row, r) => [table.index[r] ?? '', ...row].map(cell));
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const out = [line(head), line(rule), ...body.map(line)];
  if (table.total > table.rows.length) out.push('', `*The first ${table.rows.length} of ${table.total} rows.*`);
  return out.join('\n');
}

/** The document as Pandoc Markdown, code hidden. */
export function toMarkdown(cells: ExportCell[]): string {
  const blocks: string[] = [];
  let title: string | null = null;
  cells.forEach((cell, i) => {
    if (cell.kind === 'text') {
      let prose = cell.prose.trim();
      // The document's opening heading is its title.
      if (i === 0 && title === null) {
        const match = /^# +(.+?)\s*#*\s*(\n|$)/.exec(prose);
        if (match) {
          title = match[1].trim();
          prose = prose.slice(match[0].length).trim();
        }
      }
      if (prose) blocks.push(prose);
      return;
    }
    if (cell.table) blocks.push(pipeTable(cell.table));
    for (const svg of cell.figures) blocks.push(`![](${svgDataUrl(svg)})`);
  });
  const front = title === null ? '' : `---\ntitle: ${JSON.stringify(title)}\n---\n\n`;
  return front + blocks.join('\n\n') + '\n';
}

/** The export's file name: the document's, as .md. */
export function exportName(documentName: string): string {
  const stem = documentName.replace(/\.[^./\\]+$/, '') || 'Untitled';
  return `${stem}.md`;
}
