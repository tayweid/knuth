# pyrmd — Development Plan

## Current State

Phase 1 is partially complete with a working Tauri v2 + React + TypeScript scaffold:
- Tauri shell with native window, file dialogs, file read/write commands
- TipTap-based editor with CodeMirror 6 code cells
- Cmd+S save, Cmd+Shift+C to insert code cell
- Vite dev server on port 1420

**Key migration**: the editor is switching from TipTap to **Milkdown** for lossless markdown round-tripping. This is the first task before other work proceeds.

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Desktop shell | Tauri v2 (Rust) | Native window, system webview, file I/O, process management |
| Markdown editor | Milkdown | WYSIWYG markdown editing, lossless round-tripping |
| Code editing | CodeMirror 6 | Syntax-highlighted Python editing within code cells |
| Math rendering | KaTeX (via Milkdown plugin) | LaTeX math in prose |
| Code execution | Python sidecar process | Shared namespace, figure capture, variable interpolation |
| Communication | WebSocket (localhost) | Frontend ↔ Python sidecar |
| File watching | watchdog (Python) | Hot-reload on external file changes |
| Build tooling | Vite + TypeScript | Frontend bundling |
| Export (post-MVP) | Pandoc | PDF/HTML output |

## Phases

### Phase 1: Editor Migration (Milkdown)

**Goal**: Replace TipTap with Milkdown. Restore existing functionality (open, edit, save `.md` files) with the new editor.

**Tasks**:
1. Remove TipTap dependencies (`@tiptap/*`, `tiptap-markdown`)
2. Install Milkdown (`@milkdown/core`, `@milkdown/preset-commonmark`, `@milkdown/theme-nord` or custom theme, `@milkdown/plugin-listener`)
3. Rewrite `NotebookEditor.tsx` to initialize Milkdown instead of TipTap
4. Restore Cmd+S save (get markdown from Milkdown, write via Tauri)
5. Restore file open (load markdown into Milkdown)
6. Style to match current Typora-like appearance (serif fonts, centered layout, clean typography)
7. Verify lossless round-tripping: open a `.md` file, make no changes, save — file should be byte-identical

**Done when**: can open, edit, and save `.md` files with Milkdown, styled cleanly.

### Phase 2: Executable Code Blocks

**Goal**: Identify `exec`-tagged code blocks in the document and render them distinctly. No execution yet.

**Tasks**:
1. Write parser logic to detect `` ```python exec `` fenced blocks and extract flags (`hide`, `rerun`)
2. Create a custom Milkdown node or plugin for executable code blocks that renders them with CodeMirror 6
3. Visual distinction from regular code blocks (border, "executable" indicator, run button placeholder)
4. Per-block UI toggles: show/hide code, rerun flag
5. Arrow key navigation in/out of code cells

**Done when**: exec blocks are visually distinct, editable with CodeMirror, and togglable — but don't run yet.

### Phase 3: Python Sidecar & Execution

**Goal**: Execute code blocks and display output inline.

**Tasks**:
1. Create Python sidecar package (`pymd-server/` or similar):
   - WebSocket server (e.g., `websockets` library)
   - Code executor with shared namespace (`exec()` in a persistent dict)
   - stdout/stderr capture per block
   - matplotlib/plotly figure interception and save to `.pymd_cache/figures/`
2. Tauri launches Python sidecar on app startup (using `tauri-plugin-shell`)
3. Frontend WebSocket client connects to sidecar
4. Wire up run button: send code to sidecar, receive results, display inline
5. Support `execute_all` (run all blocks top-to-bottom)
6. Support `execute_up_to` (run blocks 1 through N)
7. Support `rerun` flag (re-execute from clean namespace through that block)
8. Display execution output below each block: stdout as text, figures as inline images, errors with traceback
9. Save outputs to `.pymd_cache/` so they persist without re-running

**Done when**: can execute Python code blocks, see output/figures inline, outputs cached to disk.

### Phase 4: Inline Variables & Interpolation

**Goal**: `{{variable}}` syntax resolves from execution namespace.

**Tasks**:
1. After execution, sidecar sends namespace snapshot (variable names → string representations) to frontend
2. Before passing markdown to Milkdown for rendering, run regex substitution: `\{\{(.+?)\}\}` → evaluated result
3. Unresolved variables left as literal `{{name}}`
4. Re-interpolate when namespace updates (after any block execution)

**Done when**: `{{variable}}` renders as computed values in the document.

### Phase 5: File Watching & Auto-Reload

**Goal**: External edits (e.g., from Claude Code) are reflected in the editor automatically.

**Tasks**:
1. Python sidecar watches open file with `watchdog`
2. On file change, send `file_changed` message to frontend
3. Frontend reloads markdown from disk into Milkdown
4. If editor has unsaved changes, prompt user to choose version
5. Debounce rapid changes (e.g., 300ms) to avoid flicker

**Done when**: editing the file in another tool updates the pymd editor live.

### Phase 6: Image Handling

**Goal**: Easy image management without touching raw markdown.

**Tasks**:
1. Drag-and-drop: intercept drop events, save image to project assets folder, insert `![](relative/path.png)` into Milkdown
2. Paste from clipboard: same flow as drag-and-drop
3. Click popover: custom Milkdown image node plugin — clicking a rendered image shows editable path and alt text fields
4. Generated figures from code execution already display inline (from Phase 3)

**Done when**: can add and manage images without seeing raw markdown paths.

### Phase 7: Math & Outline Sidebar

**Goal**: LaTeX math support and document navigation.

**Tasks**:
1. Enable Milkdown math plugin (`@milkdown/plugin-math` or equivalent) with KaTeX
2. Verify inline `$...$` and display `$$...$$` rendering
3. Build document outline sidebar:
   - Extract headings from Milkdown document state
   - Render as nested list in a right sidebar
   - Highlight heading at current scroll position
   - Click to scroll to heading
4. Toggle sidebar visibility

**Done when**: math renders correctly, sidebar shows document structure with scroll tracking.

### Phase 8: CLI

**Goal**: Command-line interface for headless use.

**Tasks**:
1. `pymd open file.md` — launch the Tauri app with that file
2. `pymd run file.md` — execute all blocks headlessly, print output to terminal, save figures to `.pymd_cache/`
3. Informational message if no exec blocks found
4. Package as installable CLI (e.g., via `cargo install` or a wrapper script)

**Done when**: can open and run files from the command line.

### Post-MVP

These are tracked but not scheduled:

- **Slides mode**: split on `---`/headings, presentation view with navigation
- **Pandoc export**: `pymd export file.md --format pdf|html`, resolve variables, embed figures
- **Cell reordering**: drag to rearrange blocks
- **Virtual environment detection**: auto-detect `.venv/`, `conda`, etc.
- **Themes**: light/dark, customizable typography
- **External file change responsiveness**: pymd currently locks the open file, so external edits (other editors, Claude Code, git operations) are blocked or cause confusion. Target behavior matches Sublime: when the file on disk changes, the editor updates live. Two pieces:
  1. **Release the file lock** — stop holding an exclusive handle; only open the file transiently for read/write. Investigate whether the lock comes from the Rust (Tauri) side, the Python sidecar watcher, or both.
  2. **Live reload on external change** — revives/completes Phase 5: watchdog fires `file_changed` → frontend reloads markdown into Crepe. If the editor has unsaved changes, prompt the user to pick disk vs. in-memory version. Debounce (~300ms) to avoid flicker during rapid writes.
- **Variable & data explorer (RStudio-style)**: horizontal 4-column layout optimized for widescreen:
  - Col 1: outline sidebar (narrow strip, collapsible)
  - Col 2: editor (main)
  - Col 3: variable/data column (collapsible) — variable explorer on top, data explorer below; clicking a DataFrame in the variable list opens it in the data explorer (grid.js)
  - Col 4: raw markdown editor (collapsible)
  - Col 3 and Col 4 are mutually exclusive when both expanded; each has its own toggle
  - Backend: new WebSocket message type to return namespace snapshot (name, type, shape/length, preview) after each execution; separate message to fetch full tabular data for a selected variable
  - Sanity-check grid.js handles wide DataFrames (horizontal scroll, many columns) cleanly

## Dependency Graph

```
Phase 1 (Milkdown migration)
├── Phase 2 (Executable code block UI)
│   └── Phase 3 (Python sidecar & execution)
│       ├── Phase 4 (Inline variables)
│       ├── Phase 5 (File watching)
│       └── Phase 8 (CLI)
├── Phase 6 (Image handling)
└── Phase 7 (Math & outline sidebar)
```

Phases 6 and 7 can be worked on in parallel with Phases 3-5 once the Milkdown migration is complete.

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| File format | Standard `.md` | Ecosystem compatibility, graceful degradation, no migration cost |
| Editor | Milkdown (not TipTap) | Lossless markdown round-tripping, markdown-native data model |
| Desktop shell | Tauri (not Electron) | ~5MB binary vs ~150MB, lower memory, Rust backend |
| Python integration | Sidecar over WebSocket (not PyO3) | Decoupled, independently testable, simpler build |
| Executable marker | `exec` flag on fenced blocks | Minimal addition to standard markdown, explicit opt-in |
| Variable syntax | `{{variable}}` | Universal, rarely conflicts with prose, supports expressions |
| Variable resolution | Final namespace (not sequential) | Simpler, one interpolation pass, values available everywhere |
| Figure storage | `.pymd_cache/` directory | Persistent without re-run, user chooses git strategy |
| Unresolved variables | Left as literal `{{name}}` | Obvious, no silent failures, no special UI needed |

## Files to Modify/Create

**Modify** (Milkdown migration):
- `package.json` — swap TipTap deps for Milkdown
- `src/components/NotebookEditor.tsx` — rewrite for Milkdown
- `src/extensions/CodeCell.ts` — rewrite as Milkdown plugin
- `src/styles.css` — update for Milkdown class names

**Remove**:
- TipTap-specific imports and extensions

**Create**:
- `src/plugins/executableCode.ts` — Milkdown plugin for exec blocks
- `src/plugins/imagePopover.ts` — click-to-edit image plugin
- `src/components/OutlineSidebar.tsx` — heading navigation
- `src/utils/interpolation.ts` — {{variable}} resolution
- `python/` — Python sidecar package (server, executor, watcher, figure capture)
