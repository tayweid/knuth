// Trimmed from Plass's src/math.ts: `renderInto` (lines ~22-34) is copied
// close to verbatim — pure KaTeX, no Typst involved. The popover source
// editor is NOT ported: Plass's version pulls in Typst ink caching
// (math-ink.ts), document-wide macro settings (settings.ts), and the live
// typesetter (typeset-plugin.ts) to keep the editor's KaTeX echo and the
// compiled PDF in visual sync — none of that exists in this stack, so this
// is a minimal, dependency-free equivalent instead: click the atom, edit
// attrs.src in a small panel over a live KaTeX preview, Enter commits
// (Mod-Enter for a multi-line display source, where plain Enter adds a
// line), Escape cancels.

import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { schema } from './schema.ts';

function renderInto(el: HTMLElement, src: string, displayMode: boolean) {
  if (!src.trim()) {
    el.innerHTML = `<span class="math-placeholder">${displayMode ? 'equation' : 'math'}</span>`;
    return;
  }
  try {
    katex.render(src, el, { displayMode, throwOnError: false });
  } catch {
    el.textContent = src;
  }
}

export class MathView implements NodeView {
  dom: HTMLElement;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    const display = node.type.name === 'math_display';
    this.dom = document.createElement(display ? 'div' : 'span');
    this.dom.className = display ? 'math-display' : 'math-inline';
    renderInto(this.dom, node.attrs.src as string, display);
    this.dom.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = this.getPos();
      if (pos !== undefined) openMathEditor(this.view, pos);
    });
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    renderInto(this.dom, node.attrs.src as string, node.type.name === 'math_display');
    return true;
  }

  selectNode() {
    this.dom.classList.add('math-selected');
  }

  deselectNode() {
    this.dom.classList.remove('math-selected');
  }

  ignoreMutation() {
    return true;
  }
}

// Only one popover at a time — a second click while one is open is a
// mis-click, not a request for two.
let editorOpen = false;

export function openMathEditor(view: EditorView, pos: number) {
  const node = view.state.doc.nodeAt(pos);
  if (!node || (node.type !== schema.nodes.math_inline && node.type !== schema.nodes.math_display)) return;
  if (editorOpen) return;
  editorOpen = true;

  const display = node.type.name === 'math_display';
  const panel = document.createElement('div');
  panel.className = 'math-editor';
  const preview = document.createElement('div');
  preview.className = 'math-editor-preview';
  const input = document.createElement('textarea');
  input.className = 'math-editor-input';
  input.rows = display ? 3 : 1;
  input.spellcheck = false;
  input.value = (node.attrs.src as string).trim();
  panel.append(preview, input);

  const updatePreview = () => renderInto(preview, input.value.trim(), display);
  updatePreview();
  input.addEventListener('input', updatePreview);

  document.body.appendChild(panel);
  const target = view.nodeDOM(pos);
  const rect = target instanceof HTMLElement ? target.getBoundingClientRect() : view.coordsAtPos(pos);
  panel.style.left = `${rect.left + window.scrollX}px`;
  panel.style.top = `${rect.bottom + window.scrollY + 4}px`;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    editorOpen = false;
    panel.remove();
    view.focus();
  };

  const commit = () => {
    if (closed) return;
    const edited = input.value.trim();
    const current = view.state.doc.nodeAt(pos);
    // An unchanged source is a close, not an edit: a no-op setNodeMarkup
    // still reads as docChanged and would reserialize the cell. Real
    // edits keep the node's authored whitespace form (single-line vs
    // block), which the serializer round-trips.
    const orig = current ? (current.attrs.src as string) : '';
    if (current && current.type === node.type && edited === orig.trim()) {
      close();
      return;
    }
    const pad = display ? (orig.includes('\n') ? '\n' : ' ') : '';
    const src = edited ? pad + edited + pad : '';
    if (current && current.type === node.type) {
      const tr = src
        ? view.state.tr
            .setNodeMarkup(pos, undefined, { src })
            .setSelection(TextSelection.near(view.state.doc.resolve(pos + current.nodeSize), 1))
        : view.state.tr.delete(pos, pos + current.nodeSize);
      view.dispatch(tr);
    }
    close();
  };

  const cancel = () => {
    if (closed) return;
    // Cancelling a never-filled node removes it.
    const current = view.state.doc.nodeAt(pos);
    if (current && current.type === node.type && !current.attrs.src) {
      view.dispatch(view.state.tr.delete(pos, pos + current.nodeSize));
    }
    close();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Enter' && !display) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
  // Commit when focus truly leaves the panel.
  panel.addEventListener('focusout', (e) => {
    if (!panel.contains(e.relatedTarget as Node)) commit();
  });

  input.focus();
  input.select();
}
