// The PEP 723 inline metadata block ("# /// script" … "# ///") lives in
// the document's preamble, above the first cell marker. The engine owns
// it (docs/ENVIRONMENT.md): after it installs a package or creates a file
// it rewrites the block on disk and sends the page the new lines, and the
// page splices them in rather than reloading the whole document — an
// unsaved edit must survive the engine's write.

const HEADER_START = /^# \/\/\/ script\s*$/;
const HEADER_END = /^# \/\/\/\s*$/;

/** [start, end] line indexes of the block within `lines`, inclusive, or null. */
export function findHeader(lines: string[]): [number, number] | null {
  const start = lines.findIndex((line) => HEADER_START.test(line));
  if (start < 0) return null;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (HEADER_END.test(lines[index])) return [start, index];
  }
  return null;
}

/** The preamble with `header` replacing its block, or leading it when it
 *  had none (a blank line keeps the block off whatever followed). */
export function spliceHeader(preamble: string[], header: string[]): string[] {
  const found = findHeader(preamble);
  if (found) {
    const [start, end] = found;
    return [...preamble.slice(0, start), ...header, ...preamble.slice(end + 1)];
  }
  const rest = preamble[0] === undefined || preamble[0].trim() === '' ? preamble : ['', ...preamble];
  return [...header, ...(rest.length === 0 ? [''] : rest)];
}
