// Trimmed from Plass's src/md-serializer.ts: the mirror of md-parser, minus
// every Typst/Plass escape hatch. Plass's default case falls back to a
// ```typst fence for anything with no Markdown form; here there is no
// Typst to fall back to, so an unknown node type is a bug — throw instead
// of silently emitting foreign syntax.

import type { Node as PMNode, Mark } from 'prosemirror-model';

export function docToMd(doc: PMNode): string {
  const out: string[] = [];

  const esc = (text: string): string =>
    text
      .replace(/([\\`*[\]$])/g, '\\$1')
      // A literal ~~ run would read back as strikethrough.
      .replace(/~(?=~)/g, '\\~')
      .replace(/(^|\s)_/g, '$1\\_')
      .replace(/_(?=\s|$)/g, '\\_');

  const inline = (node: PMNode): string => {
    let md = '';
    node.forEach((child) => {
      if (child.isText && child.text) {
        let t = '';
        const marks = child.marks;
        const has = (name: string) => marks.some((m: Mark) => m.type.name === name);
        if (has('code')) t = '`' + child.text + '`';
        else {
          t = esc(child.text);
          if (has('strong')) t = `**${t}**`;
          if (has('em')) t = `*${t}*`;
          if (has('strike')) t = `~~${t}~~`;
        }
        const link = marks.find((m: Mark) => m.type.name === 'link');
        if (link) t = `[${t}](${link.attrs.href as string})`;
        md += t;
        return;
      }
      switch (child.type.name) {
        case 'math_inline':
          md += `$${child.attrs.src as string}$`;
          break;
        case 'hard_break':
          md += '\\\n';
          break;
        default:
          throw new Error(`docToMd: no Markdown form for inline node "${child.type.name}"`);
      }
    });
    return md;
  };

  const block = (node: PMNode): string => {
    switch (node.type.name) {
      case 'paragraph':
        return inline(node);
      case 'heading':
        return `${'#'.repeat(node.attrs.level as number)} ${inline(node)}`;
      case 'math_display':
        // src carries its authored whitespace (md-parser), so both the
        // single-line and three-line forms round-trip byte-stably.
        return `$$${node.attrs.src as string}$$`;
      case 'code_block':
        return `\`\`\`\n${node.textContent}\n\`\`\``;
      case 'blockquote': {
        const inner: string[] = [];
        node.forEach((child) => inner.push(block(child)));
        return inner.join('\n>\n').replace(/^/gm, '> ');
      }
      case 'bullet_list':
      case 'ordered_list': {
        const ordered = node.type.name === 'ordered_list';
        const start = (node.attrs.order as number) || 1;
        const items: string[] = [];
        node.forEach((item, _o, i) => {
          const marker = ordered ? `${start + i}. ` : '- ';
          const hang = ' '.repeat(marker.length);
          const inner: string[] = [];
          item.forEach((child) => inner.push(block(child)));
          items.push(marker + inner.join(`\n\n${hang}`).replace(/\n(?!\n)/g, `\n${hang}`));
        });
        return items.join('\n');
      }
      case 'horizontal_rule':
        return '---';
      default:
        throw new Error(`docToMd: no Markdown form for block node "${node.type.name}"`);
    }
  };

  doc.forEach((node) => {
    const text = block(node);
    if (text) out.push(text);
  });

  return out.filter(Boolean).join('\n\n') + '\n';
}
