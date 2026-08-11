import { forwardRef, useEffect, useImperativeHandle, useCallback } from "react";
import { Milkdown, useEditor } from "@milkdown/react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { editorViewCtx, serializerCtx, parserCtx, editorViewOptionsCtx } from "@milkdown/kit/core";
import { OutlineSidebar } from "./OutlineSidebar";
import { RawMarkdownPanel } from "./RawMarkdownPanel";
import "@milkdown/crepe/theme/common/prosemirror.css";
import "@milkdown/crepe/theme/common/reset.css";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/common/block-edit.css";
import "@milkdown/crepe/theme/common/code-mirror.css";
import "@milkdown/crepe/theme/common/cursor.css";
import "@milkdown/crepe/theme/common/image-block.css";
import "@milkdown/crepe/theme/common/latex.css";
import "@milkdown/crepe/theme/common/link-tooltip.css";
import "@milkdown/crepe/theme/common/list-item.css";
import "@milkdown/crepe/theme/common/placeholder.css";
import "@milkdown/crepe/theme/common/table.css";
import "@milkdown/crepe/theme/common/toolbar.css";
import "@milkdown/crepe/theme/classic.css";

import { codeBlockWithMeta } from "../plugins/codeBlockExtension";
import { cleanMarkdownOutput, insertBlankParagraphs } from "../plugins/cleanLineBreaks";
import {
  paragraphSchema,
  headingSchema,
  blockquoteSchema,
  bulletListSchema,
  orderedListSchema,
  hrSchema,
} from "@milkdown/kit/preset/commonmark";
import { codeBlockView, codeBlockGuardPlugin } from "../plugins/codeMirrorBlock";
import { interpolationPlugin, getNamespace } from "../plugins/interpolationPlugin";
import { setNamespace } from "../plugins/interpolationPlugin";

export interface NotebookEditorHandle {
  getMarkdown: () => string;
  getRenderedMarkdown: () => string;
  insertCodeBlock: () => void;
}

interface NotebookEditorProps {
  initialContent: string;
  onSave: (content: string) => void;
  onContentChange?: () => void;
}

export const NotebookEditor = forwardRef<NotebookEditorHandle, NotebookEditorProps>(
  ({ initialContent, onSave, onContentChange }, ref) => {
    const { get: getEditor, loading } = useEditor(
      (container) => {
        console.log("[pymd] Creating Crepe editor");
        const crepe = new Crepe({
          root: container as unknown as Node,
          defaultValue: initialContent,
          features: {
            // Use Crepe's built-in features
            [CrepeFeature.BlockEdit]: true,
            [CrepeFeature.Toolbar]: true,
            [CrepeFeature.Placeholder]: true,
            [CrepeFeature.Cursor]: true,
            [CrepeFeature.LinkTooltip]: true,
            [CrepeFeature.ImageBlock]: true,
            [CrepeFeature.ListItem]: true,
            [CrepeFeature.Latex]: true,
            [CrepeFeature.Table]: true,
            // Keep CodeMirror enabled (required by LaTeX) — our $view overrides it for code blocks
            [CrepeFeature.CodeMirror]: true,
          },
          featureConfigs: {
            [CrepeFeature.Placeholder]: {
              text: "Start writing...",
              mode: "doc",
            },
            [CrepeFeature.ImageBlock]: {
              onUpload: async (file: File) => {
                // Try to save via Tauri, fall back to data URI
                try {
                  const { invoke } = await import("@tauri-apps/api/core");
                  const buffer = await file.arrayBuffer();
                  const bytes = Array.from(new Uint8Array(buffer));
                  const relativePath = await invoke<string>("save_image", {
                    filename: file.name,
                    bytes,
                  });
                  return relativePath;
                } catch {
                  // Not in Tauri or save failed — use data URI
                  return new Promise<string>((resolve) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result as string);
                    reader.readAsDataURL(file);
                  });
                }
              },
            },
          },
        });

        // Make block nodes selectable so drag-and-drop works
        const makeSelectable = (schema: any) =>
          schema.extendSchema((prev: any) => (ctx: any) => ({
            ...prev(ctx),
            selectable: true,
          }));

        crepe.editor
          // Selectable blocks for drag-and-drop
          .use(makeSelectable(paragraphSchema))
          .use(makeSelectable(headingSchema))
          .use(makeSelectable(blockquoteSchema))
          .use(makeSelectable(bulletListSchema))
          .use(makeSelectable(orderedListSchema))
          .use(makeSelectable(hrSchema))
          // pymd-specific plugins
          .use(codeBlockWithMeta)
          .use(codeBlockView)
          .use(codeBlockGuardPlugin)
          .use(interpolationPlugin);

        // Ensure the editor accepts drops by preventing default on dragover
        const editorEl = container;
        editorEl.addEventListener("dragover", (e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        });
        editorEl.addEventListener("drop", (e) => {
          console.log("[pymd] drop on editor container");
        });

        console.log("[pymd] Crepe configured, returning builder");
        return crepe;
      },
      [initialContent]
    );

    const getMarkdown = useCallback((): string => {
      const editor = getEditor();
      if (!editor) return "";
      try {
        const view = editor.ctx.get(editorViewCtx);
        const serializer = editor.ctx.get(serializerCtx);
        return cleanMarkdownOutput(serializer(view.state.doc));
      } catch {
        return "";
      }
    }, [getEditor]);

    const getRenderedMarkdown = useCallback((): string => {
      const raw = getMarkdown();
      const ns = getNamespace();
      return raw.replace(/\{\{(.+?)\}\}/g, (_match, expr) => {
        const key = expr.trim();
        return key in ns ? ns[key] : `{{${key}}}`;
      });
    }, [getMarkdown]);

    const insertCodeBlock = useCallback(() => {
      const editor = getEditor();
      if (!editor) return;
      try {
        const view = editor.ctx.get(editorViewCtx);
        const codeBlock = view.state.schema.nodes.code_block.create(
          { language: "python exec" }
        );
        view.dispatch(view.state.tr.replaceSelectionWith(codeBlock));
        view.focus();
      } catch {
        // Editor not ready
      }
    }, [getEditor]);

    useImperativeHandle(ref, () => ({ getMarkdown, getRenderedMarkdown, insertCodeBlock }), [getMarkdown, getRenderedMarkdown, insertCodeBlock]);

    // Replace content when a new file is opened
    useEffect(() => {
      if (loading) return;
      const editor = getEditor();
      if (!editor || editor.status !== "Created") return;
      try {
        const view = editor.ctx.get(editorViewCtx);
        const parser = editor.ctx.get(parserCtx);
        const doc = parser(initialContent);
        if (doc) {
          const fixedDoc = insertBlankParagraphs(initialContent, doc, view.state.schema);
          const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, fixedDoc.content);
          view.dispatch(tr);
        }
      } catch {
        // Editor not ready yet
      }
    }, [initialContent, getEditor, loading]);

    // Cmd+S to save, Cmd+Shift+C to insert code block
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          onSave(getMarkdown());
        }
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "c") {
          e.preventDefault();
          insertCodeBlock();
        }
      };
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [onSave, getMarkdown, insertCodeBlock]);

    return (
      <div className="editor-layout">
        <OutlineSidebar />
        <div className="editor-wrapper">
          <div className="notebook-content">
            <Milkdown />
          </div>
        </div>
        <RawMarkdownPanel />
      </div>
    );
  }
);

NotebookEditor.displayName = "NotebookEditor";
