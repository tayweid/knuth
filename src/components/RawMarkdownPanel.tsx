import { useEffect, useState, useRef, useCallback } from "react";
import { useInstance } from "@milkdown/react";
import { editorViewCtx, serializerCtx, parserCtx } from "@milkdown/kit/core";
import { cleanMarkdownOutput, insertBlankParagraphs } from "../plugins/cleanLineBreaks";

export function RawMarkdownPanel() {
  const [loading, getEditor] = useInstance();
  const [expanded, setExpanded] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const textareaFocused = useRef(false);

  // Sync editor → raw panel (only when textarea isn't focused)
  const syncFromEditor = useCallback(() => {
    if (loading || textareaFocused.current) return;
    const editor = getEditor();
    if (!editor) return;
    try {
      const view = editor.ctx.get(editorViewCtx);
      const serializer = editor.ctx.get(serializerCtx);
      setMarkdown(cleanMarkdownOutput(serializer(view.state.doc)));
    } catch {}
  }, [loading, getEditor]);

  useEffect(() => {
    if (!expanded || loading) return;
    syncFromEditor();
    const interval = setInterval(syncFromEditor, 1000);
    return () => clearInterval(interval);
  }, [expanded, loading, syncFromEditor]);

  // Raw panel → editor
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newMd = e.target.value;
    setMarkdown(newMd);

    const editor = getEditor();
    if (!editor || loading) return;
    try {
      const view = editor.ctx.get(editorViewCtx);
      const parser = editor.ctx.get(parserCtx);
      const doc = parser(newMd);
      if (doc) {
        const fixedDoc = insertBlankParagraphs(newMd, doc, view.state.schema);
        const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, fixedDoc.content);
        view.dispatch(tr);
      }
    } catch {}
  };

  return (
    <div className={`panel-right ${expanded ? "panel-expanded" : "panel-collapsed"}`}>
      <button
        className="panel-toggle panel-toggle-right"
        onClick={() => {
          setExpanded(!expanded);
          if (!expanded) syncFromEditor();
        }}
        title={expanded ? "Collapse source" : "Show source"}
      >
        {expanded ? "›" : "‹"}
      </button>
      {expanded && (
        <div className="raw-content">
          <div className="raw-header">SOURCE</div>
          <textarea
            className="raw-textarea"
            value={markdown}
            onChange={handleTextareaChange}
            onFocus={() => { textareaFocused.current = true; }}
            onBlur={() => {
              textareaFocused.current = false;
              setTimeout(syncFromEditor, 200);
            }}
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
}
