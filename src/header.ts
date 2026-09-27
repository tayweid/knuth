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

/** The packages a header lists, as "name version" for an exact pin and
 *  the requirement as written otherwise: the collapsed header's summary. */
export function headerPackages(lines: string[]): string[] {
  const found = findHeader(lines);
  if (!found) return [];
  const [start, end] = found;
  const out: string[] = [];
  let inList = false;
  for (const line of lines.slice(start + 1, end)) {
    const body = line.replace(/^#\s?/, '');
    if (!inList) {
      const inline = /^dependencies\s*=\s*\[(.*)\]\s*$/.exec(body);
      if (inline) {
        for (const match of inline[1].matchAll(/"([^"]+)"/g)) out.push(match[1]);
        break;
      }
      if (/^dependencies\s*=\s*\[\s*$/.test(body)) inList = true;
      continue;
    }
    if (/^\]/.test(body.trim())) break;
    const item = /"([^"]+)"/.exec(body);
    if (item) out.push(item[1]);
  }
  return out.map((spec) => {
    const exact = /^([A-Za-z0-9._-]+)(?:\[[^\]]*\])?==([^;\s]+)/.exec(spec);
    return exact ? `${exact[1]} ${exact[2]}` : spec;
  });
}
