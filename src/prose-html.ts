// Markdown -> HTML string, before sanitization. Kept apart from
// text-render.ts's DOMPurify/KaTeX stages (which need a real browser DOM
// to run at all — see text-render.test.ts) so this stage, which needs no
// DOM, has a module graph the Node unit test can safely import.

import MarkdownIt from 'markdown-it';

// html:false — prose is not a place to author markup; raw HTML the user
// types stays literal, escaped text, same as GitHub's own comment boxes.
// linkify/typographer off: no autolinking guesses, no smart-quote
// substitution — the rendered view should not surprise someone who wrote
// plain text expecting it back unchanged. markdown-it's default link
// validator already refuses javascript:/vbscript:/file: schemes; DOMPurify
// (text-render.ts) is the second, independent layer over this output.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

export function renderMarkdown(markdownText: string): string {
  return md.render(markdownText);
}
