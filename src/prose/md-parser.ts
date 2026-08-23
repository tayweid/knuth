// Trimmed from Plass's src/md-parser.ts: markdown-it core config, the math
// sentinel pre-pass (kept near-verbatim — self-contained, and the only way
// $...$ math survives markdown-it's emphasis rules intact), and generic
// block/inline token walking. Dropped citations, eq_refs, footnotes (and
// the markdown-it-footnote plugin), figures (an `image` token becomes its
// literal markdown text, plain text — no figure node here), abstract/
// bibtex/typst-fence special cases, and all frontmatter/settings/
// input-limits plumbing: Knuth cells are small, untitled markdown prose,
// not whole documents.

import MarkdownIt from 'markdown-it';
import type { Node as PMNode, Mark } from 'prosemirror-model';
import { schema } from './schema.ts';

export interface MdImport {
  doc: PMNode;
  warnings: string[];
}

interface MdToken {
  type: string;
  tag: string;
  content: string;
  info: string;
  children: MdToken[] | null;
  attrGet(name: string): string | null;
}

// Math placeholders use a private-use character: markdown-it passes it
// through verbatim (NUL would be rewritten to U+FFFD per CommonMark).
const S = '';

export function mdToDoc(markdown: string): MdImport {
  const warnings: string[] = [];
  let src = markdown.replace(/\r\n?/g, '\n');

  // ---------- math extraction (fence- and code-span-aware) ----------
  const inlineMath: string[] = [];
  const displayMath: string[] = [];
  {
    const out: string[] = [];
    const lines = src.split('\n');
    let fence: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const open = /^(```+|~~~+)/.exec(line);
      if (fence) {
        out.push(line);
        if (open && open[1].startsWith(fence[0]) && open[1].length >= fence.length) fence = null;
        continue;
      }
      if (open) {
        fence = open[1];
        out.push(line);
        continue;
      }
      // Display block: $$ ... $$ (single- or multi-line).
      const d = /^\s*\$\$(.*)$/.exec(line);
      if (d) {
        // The src keeps the authored whitespace around the TeX — `$$ x $$`
        // and the three-line form both round-trip byte-stably, because the
        // serializer just writes $$src$$ back. KaTeX ignores the padding.
        let body = '';
        const closeSame = /^(.*?)\$\$\s*$/.exec(d[1]);
        if (closeSame && closeSame[1].trim()) {
          body = closeSame[1];
        } else {
          const buf: string[] = [];
          if (d[1].trim()) buf.push(d[1].trim());
          let j = i + 1;
          for (; j < lines.length; j++) {
            const c = /^(.*?)\$\$\s*$/.exec(lines[j]);
            if (c) {
              if (c[1].trim()) buf.push(c[1].trim());
              break;
            }
            buf.push(lines[j]);
          }
          if (j >= lines.length) {
            out.push(line); // unclosed — leave as text
            continue;
          }
          i = j;
          body = `\n${buf.join('\n')}\n`;
        }
        out.push(`${S}B${displayMath.length}${S}`);
        displayMath.push(body);
        continue;
      }
      // Inline math outside code spans: $x$ (no surrounding spaces inside).
      out.push(
        line
          .split(/(`[^`]*`)/)
          .map((seg, k) => {
            if (k % 2 === 1) return seg;
            return seg.replace(/(?<!\\)\$(\S(?:[^$\n]*?\S)?)\$(?!\d)/g, (_, body: string) => {
              inlineMath.push(body);
              return `${S}M${inlineMath.length - 1}${S}`;
            });
          })
          .join(''),
      );
    }
    src = out.join('\n');
  }

  // ---------- tokenize ----------
  const md = new MarkdownIt({ html: false });
  const tokens = md.parse(src, {}) as unknown as MdToken[];

  const { paragraph, heading, blockquote, code_block, horizontal_rule } = schema.nodes;

  function textWithMath(text: string, marks: readonly Mark[]): PMNode[] {
    const out: PMNode[] = [];
    const re = new RegExp(`${S}M(\\d+)${S}`, 'g');
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(schema.text(text.slice(last, m.index), marks));
      out.push(schema.nodes.math_inline.create({ src: inlineMath[+m[1]] }));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(schema.text(text.slice(last), marks));
    return out;
  }

  function parseInline(children: MdToken[]): PMNode[] {
    const out: PMNode[] = [];
    let marks: Mark[] = [];
    for (const t of children) {
      switch (t.type) {
        case 'text':
          if (t.content) out.push(...textWithMath(t.content, marks));
          break;
        case 'code_inline':
          out.push(schema.text(t.content, [...marks, schema.marks.code.create()]));
          break;
        case 'strong_open':
          marks = [...marks, schema.marks.strong.create()];
          break;
        case 'em_open':
          marks = [...marks, schema.marks.em.create()];
          break;
        case 'link_open':
          marks = [...marks, schema.marks.link.create({ href: t.attrGet('href') ?? '', title: t.attrGet('title') })];
          break;
        case 's_open':
          marks = [...marks, schema.marks.strike.create()];
          break;
        case 'strong_close':
        case 'em_close':
        case 'link_close':
        case 's_close':
          marks = marks.slice(0, -1);
          break;
        case 'softbreak':
          out.push(schema.text(' ', marks));
          break;
        case 'hardbreak':
          out.push(schema.nodes.hard_break.create());
          break;
        case 'image': {
          // No figure node in this schema (v1) — keep the literal markdown
          // so the source survives, degraded to plain text.
          const alt = t.content ?? '';
          const src = t.attrGet('src') ?? '';
          const title = t.attrGet('title');
          const titlePart = title ? ` "${title}"` : '';
          warnings.push('image degraded to literal markdown text');
          out.push(schema.text(`![${alt}](${src}${titlePart})`, marks));
          break;
        }
        case 'html_inline':
          if (t.content.trim()) {
            warnings.push('inline HTML kept as plain text');
            out.push(schema.text(t.content, marks));
          }
          break;
        default:
          if (t.content) out.push(...textWithMath(t.content, marks));
      }
    }
    return out;
  }

  /** Consume tokens from `i` until the matching close token; returns blocks. */
  function parseBlocks(i: number, closeType: string | null): { nodes: PMNode[]; next: number } {
    const nodes: PMNode[] = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (closeType && t.type === closeType) return { nodes, next: i + 1 };
      switch (t.type) {
        case 'heading_open': {
          const level = +t.tag.slice(1);
          const inline = tokens[i + 1];
          nodes.push(heading.create({ level }, parseInline(inline?.children ?? [])));
          i += 3;
          break;
        }
        case 'paragraph_open': {
          const inline = tokens[i + 1];
          const kids = inline?.children ?? [];
          const only = kids.filter((k) => k.type !== 'text' || k.content.trim() !== '');
          const dm = only.length === 1 && only[0].type === 'text' && new RegExp(`^${S}B(\\d+)${S}$`).exec(only[0].content.trim());
          if (dm) {
            nodes.push(schema.nodes.math_display.create({ src: displayMath[+dm[1]] }));
          } else {
            const content = parseInline(kids);
            if (content.length) nodes.push(paragraph.create(null, content));
          }
          i += 3;
          break;
        }
        case 'fence':
        case 'code_block': {
          const body = t.content.replace(/\n$/, '');
          nodes.push(code_block.create(null, body ? [schema.text(body)] : []));
          i++;
          break;
        }
        case 'blockquote_open': {
          const inner = parseBlocks(i + 1, 'blockquote_close');
          nodes.push(blockquote.create(null, inner.nodes.length ? inner.nodes : [paragraph.create()]));
          i = inner.next;
          break;
        }
        case 'bullet_list_open': {
          const items = parseListItems(i + 1, 'bullet_list_close');
          nodes.push(schema.nodes.bullet_list.create(null, items.nodes));
          i = items.next;
          break;
        }
        case 'ordered_list_open': {
          const items = parseListItems(i + 1, 'ordered_list_close');
          const start = t.attrGet('start');
          nodes.push(schema.nodes.ordered_list.create(start ? { order: +start } : null, items.nodes));
          i = items.next;
          break;
        }
        case 'hr':
          nodes.push(horizontal_rule.create());
          i++;
          break;
        case 'html_block':
          warnings.push('HTML block kept as a code block');
          nodes.push(code_block.create(null, [schema.text(t.content.replace(/\n$/, ''))]));
          i++;
          break;
        default:
          i++;
      }
    }
    return { nodes, next: i };
  }

  function parseListItems(i: number, closeType: string): { nodes: PMNode[]; next: number } {
    const items: PMNode[] = [];
    while (i < tokens.length && tokens[i].type !== closeType) {
      if (tokens[i].type === 'list_item_open') {
        const inner = parseBlocks(i + 1, 'list_item_close');
        items.push(
          schema.nodes.list_item.create(null, inner.nodes.length ? inner.nodes : [paragraph.create()]),
        );
        i = inner.next;
      } else i++;
    }
    return { nodes: items, next: i + 1 };
  }

  const { nodes: body } = parseBlocks(0, null);
  if (!body.length) body.push(paragraph.create());
  const doc = schema.nodes.doc.create(null, body);
  return { doc, warnings };
}
