// renderProse's DOMPurify and KaTeX stages (text-render.ts) need a real
// browser DOM to run at all — DOMPurify has no sanitize() method without
// one, and this repo has no jsdom dependency to fake one in Node — so
// those stages are covered by tests/browser instead. What's tested here
// is the stage that needs no DOM: the markdown-it configuration
// prose-html.ts renders with, which is where html:false and the default
// link validator do their work independently of DOMPurify — and that
// katex itself, given the same delimiter content the app looks for,
// produces .katex markup.
import assert from 'node:assert/strict';
import katex from 'katex';
import { renderMarkdown } from './prose-html.ts';

// strong/heading/list render
{
  const html = renderMarkdown('# Heading\n\n**bold** text\n\n- a\n- b\n');
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<li>a<\/li>/);
  assert.match(html, /<li>b<\/li>/);
}

// <script> and img-onerror payloads in the markdown come out inert: with
// html:false, markdown-it never parses raw HTML as tags — it escapes it
// to literal text, which is inert regardless of any later sanitization.
{
  const html = renderMarkdown(
    'Text with <script>alert(1)</script> and <img src=x onerror=alert(1)> inline.',
  );
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
}

// raw HTML in prose stays literal, not just script/img specifically.
{
  const html = renderMarkdown('<div class="x">hi</div>');
  assert.doesNotMatch(html, /<div/);
  assert.match(html, /&lt;div/);
}

// javascript: hrefs are stripped — markdown-it's default link validator
// refuses the scheme outright, rendering the literal source text rather
// than an anchor (DOMPurify's own ALLOWED_URI_REGEXP is the second layer,
// exercised in the browser where DOMPurify can actually run).
{
  const html = renderMarkdown('[click me](javascript:alert(1))');
  assert.doesNotMatch(html, /<a[^>]*href/i);
  assert.doesNotMatch(html, /href="javascript:/i);
}

// An ordinary http(s) link survives as a real anchor.
{
  const html = renderMarkdown('[example](https://example.com)');
  assert.match(html, /<a href="https:\/\/example\.com">example<\/a>/);
}

// $x^2$ produces .katex markup: exercised directly against katex (the
// same call renderMathInElement makes per match), since auto-render itself
// requires a live document.
{
  const html = katex.renderToString('x^2', { throwOnError: false });
  assert.match(html, /class="katex"/);
}

console.log('text-render.test: all assertions passed');
