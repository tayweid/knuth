// `# %pip install a b` / `# !pip install a` lines name packages outright
// for the in-tab Python (pyodide-kernel.ts). Commented, so they are inert
// under a real Python and survive a round trip through the file; the
// notebook importer writes exactly this form when a notebook had a magic.

const PIP_LINE = /^\s*#\s*[%!]\s*pip\s+install\s+(.+?)\s*$/;

export function pipDirectives(code: string): string[] {
  const names: string[] = [];
  for (const line of code.split('\n')) {
    const match = PIP_LINE.exec(line);
    if (!match) continue;
    for (const token of match[1].split(/\s+/)) {
      // Flags (-q, --upgrade) are pip's business, not a package.
      if (token && !token.startsWith('-') && !names.includes(token)) names.push(token);
    }
  }
  return names;
}
