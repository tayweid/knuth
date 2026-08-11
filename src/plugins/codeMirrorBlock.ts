/**
 * CodeMirror 6 node view for Milkdown code_block nodes.
 * Registered via $view() — the correct Milkdown API for custom node views.
 */

import { $view, $prose } from "@milkdown/kit/utils";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { undo, redo } from "@milkdown/kit/prose/history";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView as ProseEditorView, NodeView } from "@milkdown/kit/prose/view";
import { EditorView as CMEditorView } from "@codemirror/view";
import { EditorState as CMEditorState } from "@codemirror/state";
import { python } from "@codemirror/lang-python";
import { basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { parseCodeBlockInfo } from "../utils/markdown";
import { pymdClient } from "../services/pymdClient";
import type { ExecutionResult } from "../services/pymdClient";
import katex from "katex";
import "katex/dist/katex.min.css";

let blockCounter = 0;

/** Registry of all active CodeMirror node views, keyed by their ProseMirror position getter */
const activeViews: Set<CodeMirrorNodeView> = new Set();

/** Simple hash of a string for cache keys */
function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash.toString(36);
}

/** Save all code block outputs to a cache file via Tauri */
export async function saveOutputCache(filePath: string) {
  if (!filePath) return;
  const cachePath = filePath + ".pymd";
  const cache: Record<string, any> = {};
  const sorted = [...activeViews].sort((a, b) => (a.getNodePos() ?? 0) - (b.getNodePos() ?? 0));
  for (const view of sorted) {
    const result = view.getCachedOutput();
    if (result && (result.stdout || result.error || result.figures.length > 0)) {
      const code = view.getCode();
      const key = hashCode(code);
      cache[key] = {
        code,
        stdout: result.stdout,
        error: result.error,
        figures: result.figures,
      };
    }
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("write_file", { path: cachePath, content: JSON.stringify(cache, null, 2) });
  } catch {}
}

/** Load output cache and apply to matching code blocks */
export async function loadOutputCache(filePath: string) {
  if (!filePath) return;
  const cachePath = filePath + ".pymd";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<{ content: string; path: string }>("read_file", { path: cachePath });
    const cache = JSON.parse(result.content) as Record<string, any>;
    // Wait for views to be created
    setTimeout(() => {
      for (const view of activeViews) {
        const code = view.getCode();
        const key = hashCode(code);
        if (cache[key]) {
          view.restoreOutput(cache[key]);
        }
      }
    }, 500);
  } catch {
    // No cache file — that's fine
  }
}

/** Get cached outputs from all code block views, keyed by exec block index */
export function getCodeBlockOutputs(): Record<string, any> {
  const outputs: Record<string, any> = {};
  let index = 0;
  // Sort views by position in the document
  const sorted = [...activeViews].sort((a, b) => {
    const posA = a.getNodePos() ?? 0;
    const posB = b.getNodePos() ?? 0;
    return posA - posB;
  });
  for (const view of sorted) {
    const cached = view.getCachedOutput();
    if (cached) {
      outputs[String(index)] = cached;
    }
    index++;
  }
  return outputs;
}

class CodeMirrorNodeView implements NodeView {
  dom: HTMLElement;
  private cmView: CMEditorView;
  private updating = false;
  private node: ProseNode;
  private blockId: string;
  private outputEl: HTMLElement;
  private runBtn: HTMLButtonElement | null = null;
  private toggleBtn: HTMLButtonElement | null = null;
  private editorContainer: HTMLElement;
  private header: HTMLElement;
  private isHidden: boolean;
  private isExec: boolean;
  private resultHandler: ((msg: any) => void) | null = null;
  private lastResult: ExecutionResult | null = null;
  private currentColumn = 0;

  constructor(
    node: ProseNode,
    private proseView: ProseEditorView,
    private getPos: () => number | undefined
  ) {
    this.node = node;
    this.blockId = `block_${blockCounter++}`;

    const info = parseCodeBlockInfo(node.attrs.language || "");
    this.isExec = info.exec;
    this.isHidden = info.hide;

    this.dom = document.createElement("div");
    this.dom.classList.add("code-cell");
    this.dom.style.background = "#f6f8fa";
    if (info.exec) this.dom.classList.add("code-cell-exec");

    // Top divider
    const topDivider = this.createDivider("above");
    this.dom.appendChild(topDivider);

    // Header
    this.header = document.createElement("div");
    this.header.classList.add("code-cell-header");
    this.dom.appendChild(this.header);
    this.buildHeader();

    // CodeMirror container
    this.editorContainer = document.createElement("div");
    this.editorContainer.classList.add("code-cell-editor");
    if (this.isHidden) this.editorContainer.style.display = "none";
    this.dom.appendChild(this.editorContainer);

    // Output area — inline styles to beat Crepe's theme
    this.outputEl = document.createElement("div");
    this.outputEl.classList.add("code-cell-output");
    this.outputEl.style.backgroundColor = "#ffffff";
    this.outputEl.style.borderRadius = "0 0 16px 16px";
    this.outputEl.style.borderTop = "1px solid #e1e4e8";
    this.outputEl.style.overflow = "hidden";
    this.dom.appendChild(this.outputEl);


    // CodeMirror
    this.cmView = new CMEditorView({
      state: CMEditorState.create({
        doc: node.textContent,
        extensions: [
          // Our keybindings must come BEFORE basicSetup to take priority
          keymap.of([
            {
              key: "Shift-Enter",
              run: () => {
                if (this.isExec) {
                  this.executeBlock();
                  return true;
                }
                return false;
              },
            },
            {
              key: "Mod-Enter",
              run: () => {
                if (this.isExec) {
                  this.executeBlock();
                  return true;
                }
                return false;
              },
            },
            {
              key: "Mod-z",
              run: () => {
                return undo(this.proseView.state, this.proseView.dispatch);
              },
            },
            {
              key: "Mod-Shift-z",
              run: () => {
                return redo(this.proseView.state, this.proseView.dispatch);
              },
            },
            {
              key: "Mod-y",
              run: () => {
                return redo(this.proseView.state, this.proseView.dispatch);
              },
            },
            {
              key: "ArrowUp",
              run: (view) => {
                const { head } = view.state.selection.main;
                const line = view.state.doc.lineAt(head);
                if (line.number === 1) {
                  this.currentColumn = head - line.from;
                  this.exitOrCreateAbove();
                  return true;
                }
                return false;
              },
            },
            {
              key: "ArrowDown",
              run: (view) => {
                const { head } = view.state.selection.main;
                const line = view.state.doc.lineAt(head);
                if (line.number === view.state.doc.lines) {
                  this.currentColumn = head - line.from;
                  this.exitOrCreateBelow();
                  return true;
                }
                return false;
              },
            },
            {
              key: "Escape",
              run: () => {
                this.exitOrCreateBelow();
                return true;
              },
            },
            {
              key: "Enter",
              run: (view) => {
                // Two empty lines at the end → exit to paragraph below
                const { head } = view.state.selection.main;
                const line = view.state.doc.lineAt(head);
                if (line.number >= 2 && line.text === "") {
                  const prevLine = view.state.doc.line(line.number - 1);
                  if (prevLine.text === "") {
                    // Remove both empty lines
                    view.dispatch({ changes: { from: prevLine.from - 1, to: line.to } });
                    this.forwardUpdate();
                    this.insertParagraphBelow();
                    return true;
                  }
                }
                return false;
              },
            },
          ]),
          basicSetup,
          python(),
          CMEditorView.updateListener.of((update) => {
            if (update.docChanged && !this.updating) this.forwardUpdate();
          }),
        ],
      }),
      parent: this.editorContainer,
    });

    if (this.isExec) {
      this.resultHandler = (msg: any) => {
        if (msg.type === "execution_result" && msg.result.block_id === this.blockId) {
          this.displayResult(msg.result);
        } else if (msg.type === "execution_results") {
          const myResult = msg.results.find((r: ExecutionResult) => r.block_id === this.blockId);
          if (myResult) this.displayResult(myResult);
        }
      };
      pymdClient.on("execution_result", this.resultHandler);
      pymdClient.on("execution_results", this.resultHandler);
    }

    activeViews.add(this);
    this.updateCollapsedState();

    // Force Crepe's wrapper to be transparent once we're in the DOM
    requestAnimationFrame(() => {
      const parent = this.dom.parentElement;
      if (parent && parent !== this.proseView.dom) {
        parent.style.background = "transparent";
        parent.style.padding = "0";
        parent.style.margin = "0";
      }
    });

    // Bottom divider
    const bottomDivider = this.createDivider("below");
    this.dom.appendChild(bottomDivider);

    // Auto-focus if the block was just created (empty)
    if (!node.textContent) {
      requestAnimationFrame(() => this.cmView.focus());
    }
  }

  private createDivider(position: "above" | "below"): HTMLElement {
    const divider = document.createElement("div");
    divider.classList.add("cell-divider", position === "above" ? "cell-divider-top" : "cell-divider-bottom");

    const dividerLine = document.createElement("div");
    dividerLine.classList.add("cell-divider-line");
    divider.appendChild(dividerLine);

    const dividerBtns = document.createElement("div");
    dividerBtns.classList.add("cell-divider-btns");

    const addCodeBtn = document.createElement("button");
    addCodeBtn.classList.add("cell-divider-btn");
    addCodeBtn.textContent = "+ Code";
    addCodeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setTimeout(() => position === "above" ? this.insertCodeBlockAbove() : this.insertCodeBlockBelow(), 0);
    });
    dividerBtns.appendChild(addCodeBtn);

    const addTextBtn = document.createElement("button");
    addTextBtn.classList.add("cell-divider-btn");
    addTextBtn.textContent = "+ Text";
    addTextBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setTimeout(() => position === "above" ? this.insertParagraphAbove() : this.insertParagraphBelow(), 0);
    });
    dividerBtns.appendChild(addTextBtn);

    divider.appendChild(dividerBtns);
    return divider;
  }

  private insertCodeBlockAbove() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const pmState = this.proseView.state;
    const newBlock = pmState.schema.nodes.code_block.create({ language: "python exec" });
    const tr = pmState.tr.insert(pos, newBlock);
    this.proseView.dispatch(tr);
  }

  private insertParagraphAbove() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const pmState = this.proseView.state;
    const paragraph = pmState.schema.nodes.paragraph.create();
    const tr = pmState.tr.insert(pos, paragraph);
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
    this.proseView.dispatch(tr);
    this.proseView.focus();
  }

  private updateCollapsedState() {
    const hasVisibleContent = !this.isHidden || this.outputEl.innerHTML.length > 0;
    this.dom.classList.toggle("code-cell-collapsed", !hasVisibleContent);
  }

  private buildHeader() {
    this.header.innerHTML = "";

    const info = parseCodeBlockInfo(this.node.attrs.language || "");

    // Left side
    const left = document.createElement("div");
    left.classList.add("code-cell-header-left");

    // Run button (only when exec)
    if (this.isExec) {
      this.runBtn = document.createElement("button");
      this.runBtn.classList.add("code-cell-run");
      this.runBtn.innerHTML = "&#9654;";
      this.runBtn.title = "Run (Cmd+Enter)";
      this.runBtn.addEventListener("click", (e) => {
        e.preventDefault();
        this.executeBlock();
      });
      left.appendChild(this.runBtn);
    } else {
      this.runBtn = null;
    }

    this.header.appendChild(left);

    // Right side
    const right = document.createElement("div");
    right.classList.add("code-cell-header-right");

    // Hide toggle (only when exec)
    if (this.isExec) {
      this.toggleBtn = document.createElement("button");
      this.toggleBtn.classList.add("code-cell-toggle");
      this.toggleBtn.classList.toggle("code-cell-toggle-on", !this.isHidden);
      this.toggleBtn.textContent = "hide";
      this.toggleBtn.title = "Toggle code visibility";
      this.toggleBtn.addEventListener("click", (e) => {
        e.preventDefault();
        this.isHidden = !this.isHidden;
        this.editorContainer.style.display = this.isHidden ? "none" : "";
        this.toggleBtn!.classList.toggle("code-cell-toggle-on", !this.isHidden);
        this.updateCollapsedState();
      });
      right.appendChild(this.toggleBtn);
    } else {
      this.toggleBtn = null;
    }

    // Exec toggle
    const execToggle = document.createElement("button");
    execToggle.classList.add("code-cell-exec-toggle");
    execToggle.classList.toggle("code-cell-exec-toggle-on", this.isExec);
    execToggle.textContent = "exec";
    execToggle.title = "Toggle executable";
    execToggle.addEventListener("click", (e) => {
      e.preventDefault();
      this.toggleExec();
    });
    right.appendChild(execToggle);

    // Language label
    const langLabel = document.createElement("span");
    langLabel.classList.add("code-cell-lang");
    langLabel.textContent = info.language || "code";
    right.appendChild(langLabel);

    // Delete button
    const deleteBtn = document.createElement("button");
    deleteBtn.classList.add("code-cell-delete");
    deleteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
    deleteBtn.title = "Delete block";
    deleteBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (deleteBtn.dataset.confirm === "true") {
        this.deleteBlock();
      } else {
        deleteBtn.dataset.confirm = "true";
        deleteBtn.classList.add("code-cell-delete-confirm");
        deleteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
        deleteBtn.title = "Click again to confirm";
        setTimeout(() => {
          deleteBtn.dataset.confirm = "";
          deleteBtn.classList.remove("code-cell-delete-confirm");
          deleteBtn.title = "Delete block";
        }, 3000);
      }
    });
    right.appendChild(deleteBtn);

    // Copy button
    const copyBtn = document.createElement("button");
    copyBtn.classList.add("code-cell-copy");
    copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    copyBtn.title = "Copy code";
    copyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      navigator.clipboard.writeText(this.cmView.state.doc.toString()).then(() => {
        copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        setTimeout(() => { copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`; }, 1500);
      });
    });
    right.appendChild(copyBtn);

    this.header.appendChild(right);
  }

  private toggleExec() {
    const pos = this.getPos();
    if (pos === undefined) return;

    const info = parseCodeBlockInfo(this.node.attrs.language || "");
    let newLang: string;

    if (this.isExec) {
      // Remove exec (and hide/rerun) flags
      newLang = info.language;
    } else {
      // Add exec flag
      newLang = `${info.language} exec`;
    }

    this.isExec = !this.isExec;
    // When turning off exec, show the code and hide the output
    if (!this.isExec) {
      if (this.isHidden) {
        this.isHidden = false;
        this.editorContainer.style.display = "";
      }
      this.outputEl.style.display = "none";
    } else {
      this.outputEl.style.display = "";
    }
    this.dom.classList.toggle("code-cell-exec", this.isExec);

    // Update the ProseMirror node attribute
    const tr = this.proseView.state.tr.setNodeMarkup(pos, undefined, {
      ...this.node.attrs,
      language: newLang,
    });
    this.proseView.dispatch(tr);

    // Rebuild header to show/hide run button
    this.buildHeader();

    // Set up or tear down result listener
    if (this.isExec && !this.resultHandler) {
      this.resultHandler = (msg: any) => {
        if (msg.type === "execution_result" && msg.result.block_id === this.blockId) {
          this.displayResult(msg.result);
        } else if (msg.type === "execution_results") {
          const myResult = msg.results.find((r: ExecutionResult) => r.block_id === this.blockId);
          if (myResult) this.displayResult(myResult);
        }
      };
      pymdClient.on("execution_result", this.resultHandler);
      pymdClient.on("execution_results", this.resultHandler);
    } else if (!this.isExec && this.resultHandler) {
      pymdClient.off("execution_result", this.resultHandler);
      pymdClient.off("execution_results", this.resultHandler);
      this.resultHandler = null;
    }
  }

  private executeBlock() {
    if (!this.isExec) return;
    if (this.runBtn) { this.runBtn.innerHTML = "&#9632;"; this.runBtn.disabled = true; this.runBtn.classList.add("code-cell-run-active"); }
    this.outputEl.textContent = "";
    this.dom.classList.add("code-cell-running");
    pymdClient.executeBlock(this.blockId, this.cmView.state.doc.toString());
  }

  getCode(): string {
    return this.cmView.state.doc.toString();
  }

  restoreOutput(cached: { stdout: string; error: string | null; figures: string[] }) {
    const result: ExecutionResult = {
      block_id: this.blockId,
      stdout: cached.stdout || "",
      stderr: "",
      error: cached.error || null,
      figures: cached.figures || [],
    };
    this.displayResult(result);
  }

  getCachedOutput(): { stdout: string; error: string | null; figures: string[]; hidden: boolean } | null {
    return {
      stdout: this.lastResult?.stdout ?? "",
      error: this.lastResult?.error ?? null,
      figures: this.lastResult?.figures ?? [],
      hidden: this.isHidden,
    };
  }

  private displayResult(result: ExecutionResult) {
    this.lastResult = result;
    if (this.runBtn) { this.runBtn.innerHTML = "&#9654;"; this.runBtn.disabled = false; this.runBtn.classList.remove("code-cell-run-active"); }
    this.dom.classList.remove("code-cell-running");
    this.outputEl.innerHTML = "";

    if (result.error) {
      const el = document.createElement("div");
      el.style.cssText = "white-space:pre-wrap;background:transparent;margin:0;padding:8px 16px;font-family:var(--font-mono);font-size:13px;color:#dc2626";
      el.textContent = result.error;
      this.outputEl.appendChild(el);
    }
    if (result.stdout) {
      const el = document.createElement("div");
      el.style.cssText = "white-space:pre-wrap;background:transparent;margin:0;padding:8px 16px;font-family:var(--font-mono);font-size:13px;color:#1a1a1a";
      el.textContent = result.stdout;
      this.outputEl.appendChild(el);
    }
    if (result.stderr && !result.error) {
      const el = document.createElement("div");
      el.style.cssText = "white-space:pre-wrap;background:transparent;margin:0;padding:8px 16px;font-family:var(--font-mono);font-size:13px;color:#b45309";
      el.textContent = result.stderr;
      this.outputEl.appendChild(el);
    }
    for (const figPath of result.figures) {
      const img = document.createElement("img");
      img.src = figPath;
      img.classList.add("code-cell-figure");
      img.alt = "Output figure";
      this.outputEl.appendChild(img);
    }
    this.updateCollapsedState();
  }

  private forwardUpdate() {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.updating = true;
    const newText = this.cmView.state.doc.toString();
    const pmState = this.proseView.state;
    const start = pos + 1;
    const end = start + this.node.content.size;
    const tr = newText
      ? pmState.tr.replaceWith(start, end, pmState.schema.text(newText))
      : pmState.tr.delete(start, end);
    this.proseView.dispatch(tr);
    this.updating = false;
  }

  private deleteBlock() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const pmState = this.proseView.state;
    const tr = pmState.tr.delete(pos, pos + this.node.nodeSize);
    // If the doc is now empty, insert a paragraph
    if (tr.doc.content.size === 0) {
      const paragraph = pmState.schema.nodes.paragraph.create();
      tr.insert(0, paragraph);
    }
    this.proseView.dispatch(tr);
    this.proseView.focus();
  }

  private insertCodeBlockBelow() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const afterPos = pos + this.node.nodeSize;
    const pmState = this.proseView.state;
    const newBlock = pmState.schema.nodes.code_block.create({ language: "python exec" });
    const tr = pmState.tr.insert(afterPos, newBlock);
    this.proseView.dispatch(tr);
  }

  private insertParagraphBelow() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const afterPos = pos + this.node.nodeSize;
    const pmState = this.proseView.state;
    const paragraph = pmState.schema.nodes.paragraph.create();
    const tr = pmState.tr.insert(afterPos, paragraph);
    tr.setSelection(TextSelection.near(tr.doc.resolve(afterPos + 1)));
    this.proseView.dispatch(tr);
    this.proseView.focus();
  }

  private exitOrCreateAbove() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const pmState = this.proseView.state;

    // If there's nothing before this node, insert a paragraph
    if (pos === 0) {
      const paragraph = pmState.schema.nodes.paragraph.create();
      const tr = pmState.tr.insert(0, paragraph);
      tr.setSelection(TextSelection.near(tr.doc.resolve(1)));
      this.proseView.dispatch(tr);
      this.proseView.focus();
    } else {
      this.exitToProse("before");
    }
  }

  private exitOrCreateBelow() {
    const pos = this.getPos();
    if (pos === undefined) return;
    const afterPos = pos + this.node.nodeSize;
    const pmState = this.proseView.state;

    // If there's nothing after this node, insert a paragraph
    if (afterPos >= pmState.doc.content.size) {
      const paragraph = pmState.schema.nodes.paragraph.create();
      const tr = pmState.tr.insert(afterPos, paragraph);
      tr.setSelection(TextSelection.near(tr.doc.resolve(afterPos + 1)));
      this.proseView.dispatch(tr);
      this.proseView.focus();
    } else {
      this.exitToProse("after");
    }
  }

  /** Focus this view's CodeMirror, placing cursor at start, end, a specific column, or nearest to an X coordinate */
  focusCM(atEnd: boolean, column?: number) {
    this.cmView.focus();
    if (atEnd && column !== undefined) {
      const lastLine = this.cmView.state.doc.line(this.cmView.state.doc.lines);
      const offset = Math.min(column, lastLine.length);
      this.cmView.dispatch({ selection: { anchor: lastLine.from + offset } });
    } else if (!atEnd && column !== undefined) {
      const firstLine = this.cmView.state.doc.line(1);
      const offset = Math.min(column, firstLine.length);
      this.cmView.dispatch({ selection: { anchor: firstLine.from + offset } });
    } else {
      const cmPos = atEnd ? this.cmView.state.doc.length : 0;
      this.cmView.dispatch({ selection: { anchor: cmPos } });
    }
  }

  /** Focus CodeMirror at a given character offset on the first or last line */
  focusCMAtCharOffset(atEnd: boolean, charOffset: number) {
    this.cmView.focus();
    const targetLine = atEnd
      ? this.cmView.state.doc.line(this.cmView.state.doc.lines)
      : this.cmView.state.doc.line(1);
    const offset = Math.min(charOffset, targetLine.length);
    this.cmView.dispatch({ selection: { anchor: targetLine.from + offset } });
  }

  /** Get this view's current position in the ProseMirror doc */
  getNodePos(): number | undefined {
    return this.getPos();
  }

  private exitToProse(direction: "before" | "after") {
    const pos = this.getPos();
    if (pos === undefined) return;

    // Check if there's an adjacent code block and focus it directly
    const adjacentPos = direction === "before" ? pos - 1 : pos + this.node.nodeSize;
    if (adjacentPos >= 0 && adjacentPos <= this.proseView.state.doc.content.size) {
      for (const view of activeViews) {
        if (view === this) continue;
        const vPos = view.getNodePos();
        if (vPos === undefined) continue;
        // Check if this view is the one right before/after us
        if (direction === "before" && vPos + view.node.nodeSize === pos) {
          view.focusCM(true, this.currentColumn);
          return;
        }
        if (direction === "after" && vPos === pos + this.node.nodeSize) {
          view.focusCM(false, this.currentColumn);
          return;
        }
      }
    }

    // Otherwise, move to regular prose, preserving character offset
    const targetPos = direction === "before" ? pos : pos + this.node.nodeSize;
    const bias = direction === "before" ? -1 : 1;

    try {
      const resolved = this.proseView.state.doc.resolve(targetPos);
      const selection = TextSelection.near(resolved, bias);
      const selPos = selection.$head.pos;

      if (selPos >= pos && selPos <= pos + this.node.nodeSize) {
        if (direction === "before") this.exitOrCreateAbove();
        else this.exitOrCreateBelow();
        return;
      }

      this.proseView.focus();
      this.proseView.dispatch(this.proseView.state.tr.setSelection(selection));

      // Adjust selection to match the character offset from CodeMirror
      const selResolved = this.proseView.state.doc.resolve(selPos);
      const lineStart = selResolved.start(selResolved.depth);
      const lineEnd = selResolved.end(selResolved.depth);
      const targetCharPos = lineStart + Math.min(this.currentColumn, lineEnd - lineStart);
      if (targetCharPos !== selPos) {
        const adjustedSel = TextSelection.near(this.proseView.state.doc.resolve(targetCharPos));
        this.proseView.dispatch(this.proseView.state.tr.setSelection(adjustedSel));
      }
    } catch {
      if (direction === "before") this.exitOrCreateAbove();
      else this.exitOrCreateBelow();
    }
  }

  update(updatedNode: ProseNode): boolean {
    if (updatedNode.type.name !== "code_block") return false;
    this.node = updatedNode;
    const newText = updatedNode.textContent;
    const cmText = this.cmView.state.doc.toString();
    if (newText !== cmText && !this.updating) {
      this.updating = true;
      this.cmView.dispatch({ changes: { from: 0, to: this.cmView.state.doc.length, insert: newText } });
      this.updating = false;
    }
    return true;
  }

  selectNode() { this.cmView.focus(); }
  stopEvent(event: Event) {
    // Allow drag/drop events through so blocks can be reordered
    const type = event.type;
    if (type === "drop" || type === "dragover" || type === "dragenter" || type === "dragleave" || type === "dragend") {
      return false;
    }
    return true;
  }
  destroy() {
    activeViews.delete(this);
    this.cmView.destroy();
    if (this.resultHandler) {
      pymdClient.off("execution_result", this.resultHandler);
      pymdClient.off("execution_results", this.resultHandler);
    }
  }
}

/**
 * ProseMirror plugin that prevents backspace from merging text into code blocks.
 * When backspacing at the start of a paragraph after a code block, it moves the
 * cursor into the code block instead.
 */
export const codeBlockGuardPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey("codeBlockGuard"),
    props: {
      handleKeyDown(view, event) {
        const { $cursor } = view.state.selection as any;
        if (!$cursor) return false;

        // Backspace guard: prevent merging text into code blocks
        if (event.key === "Backspace" && $cursor.parentOffset === 0) {
          const pos = $cursor.before($cursor.depth);
          if (pos <= 0) return false;
          const nodeBefore = view.state.doc.resolve(pos).nodeBefore;
          if (!nodeBefore || nodeBefore.type.name !== "code_block") return false;

          const parent = $cursor.parent;
          if (parent.content.size === 0) {
            const tr = view.state.tr.delete(pos, pos + parent.nodeSize);
            view.dispatch(tr);
            const codeBlockPos = pos - nodeBefore.nodeSize;
            for (const v of activeViews) {
              if (v.getNodePos() === codeBlockPos) {
                v.focusCM(true);
                break;
              }
            }
          }
          return true;
        }

        // ArrowUp: enter code block above from any position on first line
        if (event.key === "ArrowUp" && $cursor.depth > 0) {
          const coords = view.coordsAtPos($cursor.pos);
          const parentStart = $cursor.start($cursor.depth);
          const firstLineCoords = view.coordsAtPos(parentStart);
          if (Math.abs(coords.top - firstLineCoords.top) > 5) return false;

          const parentPos = $cursor.before($cursor.depth);
          if (parentPos <= 0) return false;
          const resolved = view.state.doc.resolve(parentPos);
          const nodeBefore = resolved.nodeBefore;
          if (nodeBefore && nodeBefore.type.name === "code_block") {
            const charOffset = $cursor.pos - parentStart;
            const codeBlockPos = parentPos - nodeBefore.nodeSize;
            for (const v of activeViews) {
              if (v.getNodePos() === codeBlockPos) {
                event.preventDefault();
                v.focusCMAtCharOffset(true, charOffset);
                return true;
              }
            }
          }
          // Let other plugins (mathKeyPlugin) handle non-code-block cases
          return false;
        }

        // ArrowDown: enter code block below from any position on last line
        if (event.key === "ArrowDown" && $cursor.depth > 0) {
          const coords = view.coordsAtPos($cursor.pos);
          const parentEnd = $cursor.end($cursor.depth);
          const lastLineCoords = view.coordsAtPos(parentEnd);
          if (Math.abs(coords.top - lastLineCoords.top) > 5) return false;

          const afterParent = $cursor.after($cursor.depth);
          if (afterParent >= view.state.doc.content.size) return false;
          const resolved = view.state.doc.resolve(afterParent);
          const nodeAfter = resolved.nodeAfter;
          if (nodeAfter && nodeAfter.type.name === "code_block") {
            const parentText = $cursor.parent.textContent;
            const offsetInParent = $cursor.parentOffset;
            const lastNewline = parentText.lastIndexOf("\n", offsetInParent - 1);
            const charOffset = lastNewline >= 0 ? offsetInParent - lastNewline - 1 : offsetInParent;

            for (const v of activeViews) {
              if (v.getNodePos() === afterParent) {
                event.preventDefault();
                v.focusCMAtCharOffset(false, charOffset);
                return true;
              }
            }
          }
          // Let other plugins (mathKeyPlugin) handle non-code-block cases
          return false;
        }

        return false;
      },
    },
  });
});

export const codeBlockView = $view(codeBlockSchema.node, () => {
  return (node, view, getPos) => {
    const langRaw = (node.attrs.language || "");
    const langFirst = langRaw.trim().split(/\s+/)[0].toLowerCase();
    if (langFirst === "latex") {
      return new LatexBlockView(node, view, getPos as () => number | undefined);
    }
    return new CodeMirrorNodeView(node, view, getPos as () => number | undefined);
  };
});

/**
 * Display math block view — renders LaTeX with KaTeX.
 * Click to edit the source, rendered otherwise.
 */
class LatexBlockView implements NodeView {
  dom: HTMLElement;
  private renderEl: HTMLElement;
  private editorEl: HTMLElement | null = null;
  private cmView: CMEditorView | null = null;
  private editing = false;
  private updating = false;
  private lastColumn = 0;

  constructor(
    private node: ProseNode,
    private proseView: ProseEditorView,
    private getPos: () => number | undefined
  ) {
    this.dom = document.createElement("div");
    this.dom.classList.add("pymd-latex-block");

    this.renderEl = document.createElement("div");
    this.renderEl.classList.add("pymd-latex-rendered");
    this.dom.appendChild(this.renderEl);
    this.render();

    this.dom.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.editing) this.startEditing();
    });

    // Auto-edit if created empty
    if (!node.textContent) {
      requestAnimationFrame(() => this.startEditing());
    }
  }

  private render() {
    const value = this.node.textContent;
    if (!value) {
      this.renderEl.textContent = "$$…$$";
      this.renderEl.classList.add("pymd-latex-empty");
      return;
    }
    this.renderEl.classList.remove("pymd-latex-empty");
    try {
      katex.render(value, this.renderEl, { throwOnError: false, displayMode: true });
    } catch {
      this.renderEl.textContent = `$$${value}$$`;
    }
  }

  private startEditing() {
    this.editing = true;
    this.renderEl.style.display = "none";

    this.editorEl = document.createElement("div");
    this.editorEl.classList.add("pymd-latex-editor");

    this.cmView = new CMEditorView({
      state: CMEditorState.create({
        doc: this.node.textContent,
        extensions: [
          keymap.of([
            {
              key: "Mod-z",
              run: () => undo(this.proseView.state, this.proseView.dispatch),
            },
            {
              key: "Mod-Shift-z",
              run: () => redo(this.proseView.state, this.proseView.dispatch),
            },
            {
              key: "Escape",
              run: () => { this.stopEditing("after"); return true; },
            },
            {
              key: "Mod-Enter",
              run: () => { this.stopEditing("after"); return true; },
            },
            {
              key: "ArrowUp",
              run: (view) => {
                const { head } = view.state.selection.main;
                const line = view.state.doc.lineAt(head);
                if (line.number === 1) {
                  this.lastColumn = head - line.from;
                  this.stopEditing("before");
                  return true;
                }
                return false;
              },
            },
            {
              key: "ArrowDown",
              run: (view) => {
                const { head } = view.state.selection.main;
                const line = view.state.doc.lineAt(head);
                if (line.number === view.state.doc.lines) {
                  this.lastColumn = head - line.from;
                  this.stopEditing("after");
                  return true;
                }
                return false;
              },
            },
          ]),
          basicSetup,
          CMEditorView.updateListener.of((update) => {
            if (update.docChanged && !this.updating) {
              const pos = this.getPos();
              if (pos === undefined) return;
              this.updating = true;
              const newText = this.cmView!.state.doc.toString();
              const pmState = this.proseView.state;
              const start = pos + 1;
              const end = start + this.node.content.size;
              const tr = newText
                ? pmState.tr.replaceWith(start, end, pmState.schema.text(newText))
                : pmState.tr.delete(start, end);
              this.proseView.dispatch(tr);
              this.updating = false;
            }
          }),
        ],
      }),
      parent: this.editorEl,
    });

    this.dom.appendChild(this.editorEl);
    this.cmView.focus();

    // Render on blur (click off)
    this.cmView.contentDOM.addEventListener("blur", () => {
      setTimeout(() => {
        if (this.editing && !this.cmView?.hasFocus) {
          this.stopEditing("after");
        }
      }, 100);
    });
  }

  private stopEditing(direction?: "before" | "after") {
    this.editing = false;
    if (this.cmView) {
      this.cmView.destroy();
      this.cmView = null;
    }
    if (this.editorEl) {
      this.editorEl.remove();
      this.editorEl = null;
    }
    this.renderEl.style.display = "";
    this.render();

    if (!direction) return;

    // Use requestAnimationFrame to ensure the destroyed CM editor has
    // fully released focus before we try to focus ProseMirror
    requestAnimationFrame(() => {
      const pos = this.getPos();
      if (pos === undefined) return;

      const doc = this.proseView.state.doc;
      const afterPos = pos + this.node.nodeSize;

      if (direction === "before") {
        if (pos === 0) {
          this.insertParagraphAndFocus(0);
        } else {
          const sel = TextSelection.near(doc.resolve(pos), -1);
          this.dispatchSelectionWithColumn(sel);
        }
      } else {
        if (afterPos >= doc.content.size) {
          this.insertParagraphAndFocus(afterPos);
        } else {
          const sel = TextSelection.near(doc.resolve(afterPos), 1);
          this.dispatchSelectionWithColumn(sel);
        }
      }
    });
  }

  private insertParagraphAndFocus(insertPos: number) {
    const paragraph = this.proseView.state.schema.nodes.paragraph.create();
    const tr = this.proseView.state.tr.insert(insertPos, paragraph);
    tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1)));
    this.proseView.dispatch(tr);
    this.proseView.focus();
  }

  private dispatchSelectionWithColumn(sel: ReturnType<typeof TextSelection.near>) {
    this.proseView.dispatch(this.proseView.state.tr.setSelection(sel));

    if (this.lastColumn > 0) {
      const selResolved = this.proseView.state.doc.resolve(sel.$head.pos);
      const lineStart = selResolved.start(selResolved.depth);
      const lineEnd = selResolved.end(selResolved.depth);
      const adjustedPos = lineStart + Math.min(this.lastColumn, lineEnd - lineStart);
      if (adjustedPos !== sel.$head.pos) {
        this.proseView.dispatch(
          this.proseView.state.tr.setSelection(TextSelection.near(this.proseView.state.doc.resolve(adjustedPos)))
        );
      }
    }

    this.proseView.focus();
  }

  update(updatedNode: ProseNode): boolean {
    if (updatedNode.type.name !== "code_block") return false;
    const lang = (updatedNode.attrs.language || "").trim().split(/\s+/)[0].toLowerCase();
    if (lang !== "latex") return false;
    this.node = updatedNode;
    if (!this.editing) this.render();
    return true;
  }

  selectNode() {
    if (!this.editing) this.startEditing();
  }
  stopEvent() { return this.editing; }
  destroy() {
    if (this.cmView) this.cmView.destroy();
  }
}
