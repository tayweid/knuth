// The rendered face of a text cell's prose: Markdown -> sanitized HTML ->
// KaTeX. Kept apart from the CodeMirror editor in document-view.ts so the
// overlay can be swapped for the raw editor (and back) without touching
// editor state — Jupyter's rendered/edit-mode split for markdown cells.

import DOMPurify from 'dompurify';
import renderMathInElement from 'katex/contrib/auto-render';
import 'katex/dist/katex.min.css';
import { renderMarkdown } from './prose-html.ts';

// Same posture as safe-svg.ts: an allowlist profile, not a blocklist.
// DOMPurify already strips inline event handlers unconditionally; the
// URI regexp is the extra clamp — only schemes a reader would expect to
// click through to, so a pasted `javascript:` or `data:` URL in a link
// or image src is dropped rather than sanitized-and-kept.
const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
};

// Links in prose leave the app; they should open beside it, not replace
// it, and never hand the destination a `window.opener` back to us.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Markdown text -> a detached, rendered element, safe to drop straight
 *  into the live DOM. Sanitization runs before KaTeX: KaTeX's own output
 *  markup is never passed back through DOMPurify, only the user's prose
 *  is — and by the time KaTeX sees the tree, it holds no user-authored
 *  attributes DOMPurify would have had reason to touch. */
export function renderProse(markdownText: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = DOMPurify.sanitize(renderMarkdown(markdownText), PURIFY_CONFIG);
  renderMathInElement(el, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
    ],
    throwOnError: false,
  });
  return el;
}
