import assert from 'node:assert/strict';
import {
  delimiterFor,
  splitRaw,
  splitRows,
  rowValues,
  rowLines,
  setValue,
  unquote,
  quote,
} from './csv.ts';

// splitRaw's contract: joining the raw fields with the delimiter gives
// the text back byte-for-byte, however the quoting is arranged.
for (const text of [
  '',
  'a',
  'a,b,c',
  ',',
  ',,',
  'a,,c,',
  '"a,b",c',
  '"a ""quoted"" b",c',
  '"",""',
  '"unterminated,x',
  '"a"tail,b',
  'x"mid,y',
  'a,"b',
]) {
  assert.equal(splitRaw(text, ',').join(','), text, `splitRaw round-trip: ${JSON.stringify(text)}`);
}

assert.deepEqual(splitRaw('a,b,c', ','), ['a', 'b', 'c']);
assert.deepEqual(splitRaw('"a,b",c', ','), ['"a,b"', 'c']);
assert.deepEqual(splitRaw('', ','), ['']);
assert.deepEqual(splitRaw(',', ','), ['', '']);
assert.deepEqual(splitRaw('a\tb', '\t'), ['a', 'b']);
assert.deepEqual(splitRaw('a,b', '\t'), ['a,b']);

assert.equal(unquote('"a ""q"" b"'), 'a "q" b');
assert.equal(unquote('plain'), 'plain');
assert.equal(unquote('"'), '"');
assert.equal(quote('plain', ','), 'plain');
assert.equal(quote('a,b', ','), '"a,b"');
assert.equal(quote('say "hi"', ','), '"say ""hi"""');
assert.equal(quote('two\nlines', ','), '"two\nlines"');
assert.equal(quote('plain', ',', true), '"plain"');
assert.equal(quote('a,b', '\t'), 'a,b');

assert.equal(delimiterFor('data.csv'), ',');
assert.equal(delimiterFor('DATA.CSV'), ',');
assert.equal(delimiterFor('data.tsv'), '\t');
assert.equal(delimiterFor('data.py'), null);
assert.equal(delimiterFor('notes.txt'), null);

// Every file survives split -> rowLines byte-identically, line by line.
const FILES: Record<string, string> = {
  plain: 'name,age\nada,36\ngrace,45\n',
  crlf: 'name,age\r\nada,36\r\ngrace,45\r\n',
  bom: '\uFEFFname,age\nada,36\n',
  quoted: 'name,note\n"Lovelace, Ada","said ""hi"""\n',
  multiline: 'name,note\nada,"line one\nline two"\ngrace,x\n',
  multilineCrlf: 'name,note\r\nada,"line one\r\nline two"\r\ngrace,x\r\n',
  ragged: 'a,b,c\n1\n2,3\n\n4,5,6,7\n',
  noTrailingNewline: 'a,b\n1,2',
  tabs: 'a\tb\n1,5\t2\n',
};
const linesOf = (text: string) => {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};
for (const [name, text] of Object.entries(FILES)) {
  const delim = name === 'tabs' ? '\t' : ',';
  const lines = linesOf(text);
  const rows = splitRows(lines, delim);
  const rebuilt = rows.flatMap((r) => rowLines(r, delim));
  assert.deepEqual(rebuilt, lines, `row round-trip: ${name}`);
  // Rows tile the lines exactly.
  let at = 0;
  for (const r of rows) {
    assert.equal(r.start, at, `row start: ${name}`);
    at += r.count;
  }
  assert.equal(at, lines.length, `rows cover lines: ${name}`);
}

// Values: quoting off, BOM and CR out of the fields.
{
  const rows = splitRows(linesOf(FILES.quoted), ',');
  assert.deepEqual(rowValues(rows[1]), ['Lovelace, Ada', 'said "hi"']);
  const crlf = splitRows(linesOf(FILES.crlf), ',');
  assert.deepEqual(rowValues(crlf[0]), ['name', 'age']);
  assert.deepEqual(rowValues(crlf[2]), ['grace', '45']);
  const bom = splitRows(linesOf(FILES.bom), ',');
  assert.deepEqual(rowValues(bom[0]), ['name', 'age']);
  const multi = splitRows(linesOf(FILES.multiline), ',');
  assert.equal(multi.length, 3);
  assert.deepEqual(multi.map((r) => r.count), [1, 2, 1]);
  assert.deepEqual(rowValues(multi[1]), ['ada', 'line one\nline two']);
  const ragged = splitRows(linesOf(FILES.ragged), ',');
  assert.deepEqual(ragged.map((r) => r.raws.length), [3, 1, 2, 1, 4]);
}

// An edit touches its own line only, and keeps the file's conventions:
// CRLF stays, the BOM stays, a quoted field stays quoted, and a value
// that needs quoting gets it.
{
  const lines = linesOf(FILES.crlf);
  const rows = splitRows(lines, ',');
  const before = [...lines];
  lines.splice(rows[1].start, rows[1].count, ...setValue(rows[1], 1, '37', ','));
  assert.deepEqual(lines, [before[0], 'ada,37\r', before[2]]);
}
{
  const lines = linesOf(FILES.bom);
  const rows = splitRows(lines, ',');
  lines.splice(0, 1, ...setValue(rows[0], 0, 'who', ','));
  assert.deepEqual(lines, ['\uFEFFwho,age', 'ada,36']);
}
{
  const lines = linesOf(FILES.quoted);
  const rows = splitRows(lines, ',');
  lines.splice(1, 1, ...setValue(rows[1], 0, 'Ada', ','));
  assert.equal(lines[1], '"Ada","said ""hi"""');
  lines.splice(1, 1, ...setValue(rows[1], 1, 'x', ','));
  assert.equal(lines[1], '"Ada","x"');
}
{
  const lines = linesOf(FILES.plain);
  const rows = splitRows(lines, ',');
  lines.splice(1, 1, ...setValue(rows[1], 0, 'Lovelace, Ada', ','));
  assert.equal(lines[1], '"Lovelace, Ada",36');
  assert.equal(lines[0], 'name,age');
  assert.equal(lines[2], 'grace,45');
}
// A ragged row grows to reach the edited column; a value with a newline
// makes the row span two lines, and taking it out shrinks it back.
{
  const lines = linesOf(FILES.ragged);
  const rows = splitRows(lines, ',');
  const grown = setValue(rows[1], 2, 'z', ',');
  assert.deepEqual(grown, ['1,,z']);
  const tall = setValue(rows[2], 0, 'p\nq', ',');
  assert.deepEqual(tall, ['"p', 'q",3']);
  lines.splice(rows[2].start, rows[2].count, ...tall);
  rows[2].count = tall.length;
  assert.deepEqual(splitRows(lines, ',').map((r) => r.count), [1, 1, 2, 1, 1]);
  const short = setValue(rows[2], 0, 'p', ',');
  assert.deepEqual(short, ['"p",3']);
}

console.log('csv: ok');
