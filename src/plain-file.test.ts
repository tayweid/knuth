// Plain files: which grammar a name gets, the indent a file is read as,
// and the one list of names said the same way everywhere Knuth says it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { indentOf, plainGrammarFor, TEXT_EXTENSIONS } from './plain-file.ts';

const grammar = (name: string) => plainGrammarFor(name)?.name ?? null;

// Knuth's own grammars come first: Quarto's markdown, YAML.
assert.equal(grammar('report.qmd'), 'Markdown');
assert.equal(grammar('README.MD'), 'Markdown');
assert.equal(grammar('config.yml'), 'YAML');
// The catalog, by extension and by whole name.
assert.equal(grammar('main.rs'), 'Rust');
assert.equal(grammar('App.tsx'), 'TSX');
assert.equal(grammar('index.ts'), 'TypeScript');
assert.equal(grammar('model.jl'), 'Julia');
assert.equal(grammar('analysis.R'), 'R');
assert.equal(grammar('Dockerfile'), 'Dockerfile');
assert.equal(grammar('CMakeLists.txt'), 'CMake');
// The aliases: what the catalog misses or reads as something else.
assert.equal(grammar('.zshrc.zsh'), 'Shell');
assert.equal(grammar('stub.pyi'), 'Python');
assert.equal(grammar('setup.cfg'), 'Properties files');
assert.equal(grammar('events.jsonl'), 'JSON');
// No grammar: numbered, wrapped text.
assert.equal(grammar('notes.txt'), null);
assert.equal(grammar('data.csv'), null);
assert.equal(grammar('LICENSE'), null);

// The indent a file already has.
assert.equal(indentOf('fn main() {\n\tlet x = 1;\n\tif x {\n\t\ty();\n\t}\n}\n'), '\t');
assert.equal(
  indentOf('/**\n * Docs.\n */\nclass A {\n    f() {\n        return 1;\n    }\n    /**\n     * More.\n     */\n}\n'),
  '    ',
);
assert.equal(indentOf('a:\n  b:\n    c: 1\n  d: 2\n'), '  ');
assert.equal(indentOf('one line\n'), '  ');
assert.equal(indentOf(''), '  ');

// One list, three places: the browser's picker reads TEXT_EXTENSIONS; the
// web app's file handlers and the Mac app's document types must say it.
const listed = new Set(TEXT_EXTENSIONS);
assert.equal(listed.size, TEXT_EXTENSIONS.length, 'no name twice');
for (const ext of TEXT_EXTENSIONS) assert.match(ext, /^\.[a-z0-9]+$/, ext);

const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
const handled = new Set<string>(
  manifest.file_handlers.flatMap((handler: { accept: Record<string, string[]> }) => Object.values(handler.accept).flat()),
);
assert.deepEqual([...handled].filter((ext) => ext !== '.py' && ext !== '.ipynb').sort(), [...listed].sort());

const config = JSON.parse(readFileSync(new URL('../app/knuth.json', import.meta.url), 'utf8'));
const source = config.documentTypes.find((type: { name: string }) => type.name === 'Source code');
assert.equal(source.rank, 'Alternate', 'Knuth never takes a type on install (APP.md)');
assert.equal(source.contentTypes, undefined, 'claimed by extension: a content-type list would hide these');
assert.deepEqual(source.extensions.map((ext: string) => `.${ext}`), TEXT_EXTENSIONS);

console.log('plain-file: ok');
