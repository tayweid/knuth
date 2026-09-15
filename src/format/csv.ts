// Delimited-text (.csv/.tsv) rows over a file's physical lines, for the
// grid view. The unit of editing is the line, never the table: a cell
// edit rebuilds the one row it belongs to from that row's own raw
// fields, and every other line of the file stays byte-identical — so a
// one-cell change is a one-line diff, and a file the grid never touched
// serializes exactly as it was read (quoting style, CRLF, BOM and all).
//
// Fields follow RFC 4180: a field that starts with a double quote runs
// to its closing quote (doubled quotes inside are literal quotes) and
// may span lines; anything else is literal up to the next delimiter.

export interface CsvRow {
  /** Index of the row's first physical line. */
  start: number;
  /** Physical lines the row spans (more than one when a quoted field
   *  contains a newline). */
  count: number;
  /** A byte-order mark on the file's first line, kept out of the field. */
  prefix: string;
  /** A trailing '\r' (CRLF file), kept out of the last field. */
  eol: string;
  /** Raw field texts, quotes included: joined with the delimiter (and
   *  the prefix and eol restored) they are the row's text verbatim. */
  raws: string[];
}

/** The delimiter a file name implies, or null for a file that has no
 *  grid to offer. */
export function delimiterFor(name: string): string | null {
  if (/\.tsv$/i.test(name)) return '\t';
  if (/\.csv$/i.test(name)) return ',';
  return null;
}

/** Whether the text ends inside an open quoted field — the row continues
 *  on the next physical line. */
function endsOpen(text: string, delim: string): boolean {
  let i = 0;
  let open = false;
  let fieldStart = true;
  while (i < text.length) {
    const ch = text[i];
    if (open) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else open = false;
      }
    } else if (ch === '"' && fieldStart) {
      open = true;
    } else if (ch === delim) {
      fieldStart = true;
      i++;
      continue;
    }
    fieldStart = false;
    i++;
  }
  return open;
}

/** Split one row's text into raw field texts; joining them with the
 *  delimiter gives the text back byte-for-byte. */
export function splitRaw(text: string, delim: string): string[] {
  const out: string[] = [];
  let i = 0;
  let start = 0;
  for (;;) {
    if (text[i] === '"') {
      // Quoted field: run to the closing quote. Whatever follows it up
      // to the delimiter is kept literally (malformed, but preserved).
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
    }
    while (i < text.length && text[i] !== delim) i++;
    out.push(text.slice(start, i));
    if (i >= text.length) return out;
    i++;
    start = i;
  }
}

/** A raw field's value: the quotes off and doubled quotes undoubled. */
export function unquote(raw: string): string {
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
    return raw.slice(1, -1).replace(/""/g, '"');
  }
  return raw;
}

/** A value as a raw field. Quoted when it has to be (delimiter, quote,
 *  or newline inside) — or when the field it replaces was quoted, so an
 *  edit does not strip a file's quoting style from one cell. */
export function quote(value: string, delim: string, wasQuoted = false): string {
  const needs = wasQuoted || value.includes(delim) || /["\r\n]/.test(value);
  return needs ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Group a file's physical lines into rows. */
export function splitRows(lines: string[], delim: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = i;
    let text = lines[i++];
    while (endsOpen(text, delim) && i < lines.length) text += '\n' + lines[i++];
    rows.push(makeRow(start, i - start, text, delim));
  }
  return rows;
}

function makeRow(start: number, count: number, text: string, delim: string): CsvRow {
  const prefix = start === 0 && text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const eol = text.endsWith('\r') ? '\r' : '';
  const body = text.slice(prefix.length, text.length - eol.length);
  return { start, count, prefix, eol, raws: splitRaw(body, delim) };
}

/** The row's field values, for display. */
export function rowValues(row: CsvRow): string[] {
  return row.raws.map(unquote);
}

/** The row's text as physical lines. */
export function rowLines(row: CsvRow, delim: string): string[] {
  return (row.prefix + row.raws.join(delim) + row.eol).split('\n');
}

/** Set one field of a row (padding with empty fields when the row is
 *  short of it) and return the row's new physical lines. The caller
 *  splices them over the old ones and updates `count`. */
export function setValue(row: CsvRow, index: number, value: string, delim: string): string[] {
  while (row.raws.length <= index) row.raws.push('');
  const wasQuoted = row.raws[index].startsWith('"');
  row.raws[index] = quote(value, delim, wasQuoted);
  return rowLines(row, delim);
}

/** An empty row to append after the last one, matching its line ending. */
export function emptyRow(after: CsvRow | undefined, start: number): CsvRow {
  return { start, count: 1, prefix: '', eol: after?.eol ?? '', raws: [''] };
}
