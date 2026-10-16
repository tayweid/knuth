// Plain files: everything Knuth opens that is not a .py cell document or
// an .ipynb. They open in the source editor, highlighted when CodeMirror
// knows the language and indented the way the file already is.

import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { pythonLanguage } from '@codemirror/lang-python';
import { yaml, yamlFrontmatter, yamlLanguage } from '@codemirror/lang-yaml';
import { markdown } from '@codemirror/lang-markdown';

// Every name that opens as a plain file: the browser's open picker, the
// web app's file_handlers (public/manifest.webmanifest) and the Mac app's
// document types (app/knuth.json) all say this list, which
// plain-file.test.ts holds them to. Any other text file still opens
// (Open With, a drop, the shell's own dialog) — this is the set Knuth puts
// its name to.
export const TEXT_EXTENSIONS = [
  // Prose and markup
  '.txt', '.text', '.md', '.markdown', '.qmd', '.rmd', '.rst', '.org', '.adoc', '.log',
  '.tex', '.sty', '.cls', '.bib', '.typ', '.diff', '.patch',
  // Data and configuration
  '.json', '.jsonl', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.properties', '.env', '.csv', '.tsv', '.xml', '.svg', '.sql', '.graphql', '.proto',
  // The web
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx', '.vue', '.svelte', '.php',
  // Shells and build files
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmake', '.gradle', '.tf', '.hcl',
  // Statistics and science
  '.pyi', '.r', '.jl', '.m', '.do', '.ado', '.sas', '.stan', '.f90',
  // Everything else people write
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.mm', '.cs', '.java', '.kt', '.kts',
  '.scala', '.groovy', '.swift', '.go', '.rs', '.zig', '.nim', '.dart', '.rb', '.lua',
  '.pl', '.pm', '.hs', '.ml', '.mli', '.clj', '.lisp', '.el', '.scm', '.erl', '.ex', '.exs',
];

/** Markdown as Quarto/R Markdown write it: a YAML front matter block
 *  over the prose, and code fences whose info string is braced —
 *  ```{python} — so the fence's language is read with the braces (and
 *  any chunk options after a comma or space) stripped. */
function quartoMarkdown(): LanguageSupport {
  const content = markdown({
    codeLanguages: (info) => {
      const lang = info.replace(/^\{/, '').split(/[\s,}]/)[0].toLowerCase();
      if (lang === 'python' || lang === 'py') return pythonLanguage;
      if (lang === 'yaml' || lang === 'yml') return yamlLanguage;
      return null;
    },
  });
  return yamlFrontmatter({ content });
}

/** Knuth's own grammars, ahead of CodeMirror's catalog. */
const OWN_GRAMMARS = [
  LanguageDescription.of({ name: 'Markdown', extensions: ['md', 'markdown', 'qmd', 'rmd'], load: async () => quartoMarkdown() }),
  LanguageDescription.of({ name: 'YAML', extensions: ['yaml', 'yml'], load: async () => yaml() }),
];

/** Extensions the catalog misses or reads as something else, as the one
 *  it reads them by: .cfg is not TTCN, .jsonl is JSON a line at a time. */
const ALIASES: Record<string, string> = {
  zsh: 'sh',
  pyi: 'py',
  sty: 'tex',
  cls: 'tex',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  jsonl: 'json',
  jsonc: 'json',
};

/** The grammar for a plain file, by its name — null when the editor has
 *  none for it and the file is numbered, wrapped text. Most come from
 *  CodeMirror's catalog (@codemirror/language-data), each its own chunk,
 *  fetched the first time a file needs it. */
export function plainGrammarFor(name: string): LanguageDescription | null {
  // The catalog matches extensions as written; README.MD is markdown too.
  const ext = /\.([^.]+)$/.exec(name)?.[1].toLowerCase();
  const file = ext ? name.replace(/[^.]+$/, ALIASES[ext] ?? ext) : name;
  return LanguageDescription.matchFilename(OWN_GRAMMARS, file) ?? LanguageDescription.matchFilename(languages, file);
}

/** A plain file's indent unit, from its own lines: a tab when more lines
 *  start with one than with spaces, else four or two spaces, whichever
 *  nine in ten space-indented lines are a multiple of; two for a file
 *  with no indented lines (YAML's, and the editor's old default). Odd
 *  runs of spaces are alignment, mostly a block comment's " * ". */
export function indentOf(text: string): string {
  let tabs = 0;
  const widths: number[] = [];
  for (const line of text.split('\n', 5000)) {
    const lead = /^[ \t]+(?=\S)/.exec(line)?.[0];
    if (!lead) continue;
    if (lead[0] === '\t') tabs++;
    else if (lead.length % 2 === 0) widths.push(lead.length);
  }
  if (tabs > widths.length) return '\t';
  const four = widths.filter((width) => width % 4 === 0).length;
  return widths.length > 0 && four >= widths.length * 0.9 ? '    ' : '  ';
}
