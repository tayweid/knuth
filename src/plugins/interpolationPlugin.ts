/**
 * ProseMirror plugin that visually replaces {{variable}} with computed values
 * using widget decorations. The document text remains {{variable}} — only the
 * display changes. Placing the cursor inside reveals the raw template.
 */

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";

const interpolationKey = new PluginKey("interpolation");

/** Current namespace from Python sidecar */
let namespace: Record<string, string> = {};

/** Get the current namespace */
export function getNamespace(): Record<string, string> {
  return { ...namespace };
}

/** Update the namespace and trigger a re-decoration */
export function setNamespace(ns: Record<string, string>) {
  namespace = ns;
  for (const view of activeViews) {
    view.dispatch(view.state.tr.setMeta(interpolationKey, true));
  }
}

const activeViews: Set<EditorView> = new Set();

function buildDecorations(doc: ProseNode, cursorPos: number): DecorationSet {
  const decorations: Decoration[] = [];
  const pattern = /\{\{(.+?)\}\}/g;

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;

    let match;
    while ((match = pattern.exec(node.text)) !== null) {
      const from = pos + match.index;
      const to = from + match[0].length;
      const key = match[1].trim();
      const value = namespace[key];

      // Don't decorate if cursor is inside or adjacent to this template
      if (cursorPos >= from && cursorPos <= to) {
        // Just style the raw template subtly
        decorations.push(Decoration.inline(from, to, {
          class: "interpolation-editing",
        }));
        continue;
      }

      if (value !== undefined) {
        // Hide the original text
        decorations.push(Decoration.inline(from, to, {
          class: "interpolation-hidden",
        }));
        // Insert a widget showing the value
        const widget = document.createElement("span");
        widget.classList.add("interpolation-value");
        widget.textContent = value;
        widget.title = `{{${key}}}`;
        decorations.push(Decoration.widget(from, widget, { side: -1 }));
      } else {
        decorations.push(Decoration.inline(from, to, {
          class: "interpolation-unresolved",
        }));
      }
    }
  });

  return DecorationSet.create(doc, decorations);
}

export const interpolationPlugin = $prose(() => {
  return new Plugin({
    key: interpolationKey,

    state: {
      init(_, state) {
        return buildDecorations(state.doc, state.selection.from);
      },
      apply(tr, _oldDecos, _oldState, newState) {
        if (tr.docChanged || tr.getMeta(interpolationKey) || tr.selectionSet) {
          return buildDecorations(newState.doc, newState.selection.from);
        }
        return buildDecorations(newState.doc, newState.selection.from);
      },
    },

    props: {
      decorations(state) {
        return this.getState(state);
      },
    },

    view(editorView) {
      activeViews.add(editorView);
      return {
        destroy() {
          activeViews.delete(editorView);
        },
      };
    },
  });
});
