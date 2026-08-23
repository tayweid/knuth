// Trimmed from Plass's src/md-round.test.ts: same pattern (parse, serialize,
// require exact byte convergence) run over the supported subset — no
// frontmatter/citations/footnotes/tables/bibliography here, those nodes
// don't exist in this schema.
// Run: node --import tsx src/prose/md-round.test.ts

import { mdToDoc } from './md-parser.ts';
import { docToMd } from './md-serializer.ts';
import { schema } from './schema.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

// Nested lists indent by the OUTER item's own re-indent pass, which runs
// on the whole already-hang-indented inner string — a list nested one
// level deep ends up double-indented (4 spaces, blank line before it,
// for a top-level bullet). Faithful to the serializer's actual output,
// not a hand-picked "nicer" shape.
const SRC = `# Introduction

This is **bold**, *italic*, ~~struck~~, and \`code\`, with math $a_C^2$ inline and a [link](https://example.org).

$$
\\Pi_{A,B,C} = x^2
$$

## Lists

- first item

    - nested item
- second item

1. one
2. two

> A quoted remark.

\`\`\`
print("hi")
\`\`\`

---

Closing paragraph with underscore math $x_i$ inline.
`;

const first = mdToDoc(SRC);
const doc = first.doc;

// structural spot checks
const types: string[] = [];
doc.forEach((n) => types.push(n.type.name + (n.attrs.level ? n.attrs.level : '')));
check('heading levels', types.includes('heading1') && types.includes('heading2'), JSON.stringify(types));
check('display math', (() => {
  let ok = false;
  doc.descendants((n) => {
    if (n.type.name === 'math_display' && /Pi_/.test(n.attrs.src as string)) ok = true;
    return true;
  });
  return ok;
})());
check('inline math, including the underscore case', (() => {
  let plain = false, underscore = false;
  doc.descendants((n) => {
    if (n.type.name === 'math_inline' && n.attrs.src === 'a_C^2') plain = true;
    if (n.type.name === 'math_inline' && n.attrs.src === 'x_i') underscore = true;
    return true;
  });
  return plain && underscore;
})());
check('bold/em/strike/code/link marks', (() => {
  let strong = false, em = false, strike = false, code = false, link = false;
  doc.descendants((n) => {
    if (n.isText) {
      for (const m of n.marks) {
        if (m.type.name === 'strong') strong = true;
        if (m.type.name === 'em') em = true;
        if (m.type.name === 'strike') strike = true;
        if (m.type.name === 'code') code = true;
        if (m.type.name === 'link') link = true;
      }
    }
    return true;
  });
  return strong && em && strike && code && link;
})());
check('nested list shape', (() => {
  let ok = false;
  doc.descendants((n) => {
    if (n.type.name === 'bullet_list') {
      n.descendants((inner) => {
        if (inner.type.name === 'bullet_list') ok = true;
        return true;
      });
    }
    return true;
  });
  return ok;
})());
check('blockquote present', (() => {
  let ok = false;
  doc.forEach((n) => { if (n.type.name === 'blockquote') ok = true; });
  return ok;
})());
check('code fence present', (() => {
  let ok = false;
  doc.forEach((n) => { if (n.type.name === 'code_block' && /print/.test(n.textContent)) ok = true; });
  return ok;
})());

// round trip: md -> doc -> md -> doc -> md must be stable, and byte-identical
// to the original source (not just self-consistent).
const md1 = docToMd(doc);
check('round-trip is byte-stable against the source', md1 === SRC, (() => {
  if (md1 === SRC) return '';
  const a = md1.split('\n'), b = SRC.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `first diff at line ${i}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`;
  }
  return 'differs';
})());

const second = mdToDoc(md1);
const md2 = docToMd(second.doc);
check('round-trip converges on a second pass', md1 === md2);

// The math sentinel pre-pass must run BEFORE markdown-it's emphasis rules
// see the text — otherwise `$x_i$` would tokenize the underscore as an
// (unmatched, since it's mid-word) emphasis marker rather than passing
// `x_i` through to KaTeX untouched.
check('math sentinel survives emphasis mangling', (() => {
  const { doc: d } = mdToDoc('$x_i$ and *emphasis* around it');
  let src = '';
  d.descendants((n) => {
    if (n.type.name === 'math_inline') src = n.attrs.src as string;
    return true;
  });
  return src === 'x_i';
})());

// Unknown node types have no Markdown form in this stack — never fall back
// to foreign syntax, throw instead.
check('unknown node type throws rather than emitting foreign syntax', (() => {
  const bogus = schema.nodes.doc.create(null, [schema.nodes.image.create({ src: 'x.png' })]);
  try {
    docToMd(bogus);
    return false;
  } catch {
    return true;
  }
})());

declare const process: { exitCode?: number };
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nall md round-trip tests passed');
}
