import { useEffect, useState, useCallback } from "react";
import { useInstance } from "@milkdown/react";
import { editorViewCtx } from "@milkdown/kit/core";

interface HeadingItem {
  level: number;
  text: string;
  pos: number;
}

export function OutlineSidebar() {
  const [loading, getEditor] = useInstance();
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [activePos, setActivePos] = useState<number>(-1);
  const [expanded, setExpanded] = useState(false);

  const extractHeadings = useCallback(() => {
    if (loading) return;
    const editor = getEditor();
    if (!editor) return;
    try {
      const view = editor.ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const items: HeadingItem[] = [];
      doc.forEach((node, offset) => {
        if (node.type.name === "heading") {
          items.push({
            level: node.attrs.level as number,
            text: node.textContent,
            pos: offset,
          });
        }
      });
      setHeadings(items);
    } catch {}
  }, [loading, getEditor]);

  useEffect(() => {
    if (loading) return;
    extractHeadings();
    const interval = setInterval(extractHeadings, 1000);
    return () => clearInterval(interval);
  }, [loading, getEditor, extractHeadings]);

  useEffect(() => {
    const wrapper = document.querySelector(".editor-wrapper");
    if (!wrapper || loading) return;
    const editor = getEditor();
    if (!editor) return;

    const onScroll = () => {
      try {
        const view = editor.ctx.get(editorViewCtx);
        const wrapperRect = wrapper.getBoundingClientRect();
        let closest: HeadingItem | null = null;
        for (const h of headings) {
          const coords = view.coordsAtPos(h.pos);
          if (coords && coords.top <= wrapperRect.top + 80) {
            closest = h;
          }
        }
        if (closest) setActivePos(closest.pos);
      } catch {}
    };

    wrapper.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => wrapper.removeEventListener("scroll", onScroll);
  }, [loading, getEditor, headings]);

  const scrollToHeading = (pos: number) => {
    if (loading) return;
    const editor = getEditor();
    if (!editor) return;
    try {
      const view = editor.ctx.get(editorViewCtx);
      const coords = view.coordsAtPos(pos);
      const wrapper = document.querySelector(".editor-wrapper");
      if (coords && wrapper) {
        const wrapperRect = wrapper.getBoundingClientRect();
        wrapper.scrollTo({
          top: wrapper.scrollTop + (coords.top - wrapperRect.top) - 60,
          behavior: "smooth",
        });
      }
    } catch {}
  };

  return (
    <div className={`panel-left ${expanded ? "panel-expanded" : "panel-collapsed"}`}>
      <button
        className="panel-toggle panel-toggle-left"
        onClick={() => setExpanded(!expanded)}
        title={expanded ? "Collapse outline" : "Expand outline"}
      >
        {expanded ? "‹" : "›"}
      </button>
      {expanded && (
        <div className="outline-content">
          <div className="outline-header">OUTLINE</div>
          <div className="outline-list">
            {headings.map((h, i) => (
              <div
                key={`${h.pos}-${i}`}
                className={`outline-item outline-level-${h.level} ${h.pos === activePos ? "outline-active" : ""}`}
                onClick={() => scrollToHeading(h.pos)}
              >
                {h.text || "(empty)"}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
