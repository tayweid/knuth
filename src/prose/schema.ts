// Trimmed from Plass's src/schema.ts: stock prosemirror-schema-basic +
// addListNodes, plus Plass's `strike` mark and math_inline/math_display
// (copied verbatim, plain-data attrs {src} — no label/numbered, that's
// equation-numbering territory this stack doesn't have). Dropped every
// Typst-specific node (tables, figure, footnote, citation, bibliography,
// eq_ref, typst_inline, page_break, numbering_restart, doc_title/authors/
// date, abstract) and the Typst-specific attrs Plass layers onto paragraph/
// heading/doc/code_block/image — those nodes keep their stock specs here.
// Markdown images have no node to land in yet (v1: literal text, see
// md-parser.ts), so `image` is not added back either.

import { Schema, type NodeSpec } from 'prosemirror-model';
import { schema as base } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';

const mathInline: NodeSpec = {
  group: 'inline',
  inline: true,
  atom: true,
  attrs: { src: { default: '' } },
  parseDOM: [
    {
      tag: 'span[data-math]',
      getAttrs: (el) => ({ src: (el as HTMLElement).getAttribute('data-math') ?? '' }),
    },
  ],
  toDOM: (node) => ['span', { 'data-math': node.attrs.src, class: 'math-inline' }, node.attrs.src],
};

const mathDisplay: NodeSpec = {
  group: 'block',
  atom: true,
  attrs: { src: { default: '' } },
  parseDOM: [
    {
      tag: 'div[data-math]',
      getAttrs: (el) => ({ src: (el as HTMLElement).getAttribute('data-math') ?? '' }),
    },
  ],
  toDOM: (node) => ['div', { 'data-math': node.attrs.src, class: 'math-display' }, node.attrs.src],
};

const nodes = addListNodes(base.spec.nodes, 'paragraph block*', 'block')
  .addToEnd('math_inline', mathInline)
  .addToEnd('math_display', mathDisplay);

// Strikethrough is not in schema-basic; GFM has it (~~strike~~), so it
// round-trips through markdown same as Plass's Typst pairing.
const marks = base.spec.marks.addToEnd('strike', {
  parseDOM: [
    { tag: 's' },
    { tag: 'del' },
    { tag: 'strike' },
    { style: 'text-decoration=line-through' },
  ],
  toDOM() {
    return ['s', 0] as const;
  },
});

export const schema = new Schema({ nodes, marks });
