# pyrmd — Specification

## Overview

pyrmd is a desktop markdown editor with executable Python code cells. It renders standard `.md` files as WYSIWYG documents (like Typora) while allowing embedded Python code blocks to be executed inline, with outputs and figures displayed in the document. The goal is to replace the separate use of a markdown editor and Jupyter notebooks with a single tool optimized for writing technical papers, teaching materials, and other documents that mix prose with computation.

## File Format

pymd operates on **standard `.md` files**. No custom file extension is required. Any `.md` file is a valid pymd document — files with no executable blocks simply render as static documents.

### Executable Code Blocks

A fenced code block becomes executable when tagged with `exec`:

~~~markdown
```python exec
import numpy as np
x = np.linspace(0, 10, 100)
```
~~~

Standard code blocks (without `exec`) render as syntax-highlighted samples but are not executed:

~~~markdown
```python
# This is just a code sample, not executed
print("hello")
```
~~~

### Per-Block Flags

Flags are specified on the fence line after `exec`:

~~~markdown
```python exec hide
# This code runs but is hidden in the rendered view
data = load_data("experiment.csv")
```

```python exec rerun
# This block re-executes all blocks from the top through here
model.fit(data)
```
~~~

Supported flags:
- **`hide`** — code is not displayed in the rendered document (output still shown)
- **`rerun`** — re-executes all blocks from the top of the file through this block, ensuring a clean namespace

These flags are also toggleable from the UI at runtime, independent of what's in the markdown source.

### Inline Computed Values

Variables from the execution namespace can be interpolated into prose using `{{variable}}` syntax:

```markdown
The model achieved an accuracy of {{accuracy}} on {{n_samples}} test samples.
```

After execution, if `accuracy = 0.94` and `n_samples = 1247`, this renders as:

> The model achieved an accuracy of 0.94 on 1247 test samples.

- Interpolation uses the **final shared namespace** after all executed blocks have run (not the sequential state at each block's position).
- Expressions are supported: `{{f"{accuracy:.2%}"}}`, `{{len(df)}}`.
- Unresolved variables (not yet computed or undefined) are left as literal `{{variable}}` in the rendered output.

### Images

Two categories:

1. **Static images** — standard markdown syntax referencing files on disk:
   ```markdown
   ![Alt text](./figures/diagram.png)
   ```

2. **Generated images** — produced by executable code blocks (e.g., matplotlib plots). These are captured automatically, saved to `.pymd_cache/`, and displayed inline below the code block that generated them.

### Math

Standard LaTeX math syntax, rendered via KaTeX:
- Inline: `$E = mc^2$`
- Display: `$$\int_0^\infty e^{-x} dx = 1$$`

## Architecture

```
┌─────────────────────────────────┐
│         Tauri (Rust)            │
│   Native window, menus, IPC     │
│                                 │
│  ┌───────────────────────────┐  │
│  │     System Webview        │  │
│  │                           │  │
│  │  Milkdown (WYSIWYG MD)   │  │
│  │  CodeMirror 6 (code)     │  │
│  │  KaTeX (math)            │  │
│  │  Outline sidebar         │  │
│  └───────────┬───────────────┘  │
└──────────────┼──────────────────┘
               │ WebSocket (localhost)
┌──────────────┼──────────────────┐
│  Python Sidecar Process         │
│                                 │
│  File watcher (watchdog)        │
│  Code executor (shared ns)      │
│  {{variable}} interpolation     │
│  Figure capture & caching       │
│  .pymd_cache/ management        │
└─────────────────────────────────┘
```

### Tauri Shell (Rust)

- Provides the native desktop window via system webview (no bundled Chromium)
- Manages application lifecycle, native menus, file dialogs
- Launches the Python sidecar process on startup
- File read/write commands exposed to the frontend

### Frontend (Webview)

- **Milkdown** — WYSIWYG markdown editor. The file format is native markdown, so Milkdown renders it directly with no translation layer. Markdown round-tripping is lossless.
- **CodeMirror 6** — syntax-highlighted editing for executable code blocks within Milkdown. Python language support, line numbers, standard keybindings.
- **KaTeX** — renders LaTeX math inline and in display mode via Milkdown's math plugin.
- **Document outline sidebar** — extracts headings, renders as nested list, highlights current scroll position, click to navigate.

### Python Sidecar

- Separate process launched by Tauri, communicates over localhost WebSocket
- **File watcher**: monitors the open `.md` file for changes on disk (e.g., from Claude Code or another editor). Notifies frontend to reload.
- **Code executor**: runs `exec`-tagged blocks in a shared Python namespace. Supports incremental execution (run one block) and full re-execution (rerun flag). Captures stdout, stderr, and figure output.
- **Figure capture**: intercepts matplotlib/plotly figure creation, saves to `.pymd_cache/figures/`, returns paths to frontend for inline display.
- **Interpolation**: resolves `{{variable}}` expressions against the shared namespace at render time.
- **Cache**: `.pymd_cache/` stores execution outputs (figures, stdout, variable snapshots) so the document is viewable without re-running. User decides whether to gitignore or commit this directory.

### Communication Protocol (WebSocket)

Frontend → Python:
- `execute_block { block_id, code }` — run a single code block
- `execute_all {}` — run all blocks top-to-bottom
- `execute_up_to { block_id }` — run all blocks from top through block_id
- `interpolate { text }` — resolve {{variables}} in a string

Python → Frontend:
- `execution_result { block_id, stdout, stderr, figures[] }` — block finished
- `namespace_update { variables: { name: string_value } }` — updated variable values for interpolation
- `file_changed {}` — watched file was modified externally
- `error { block_id, traceback }` — execution error

## UI Behavior

### WYSIWYG Editing
- Markdown text is rendered inline (headings, bold, italic, lists, links, images, math) — no split-pane, no raw markdown visible during normal editing.
- Editing writes back to the `.md` file on disk.

### Code Blocks
- Executable blocks are visually distinct from code samples (border, run button, status indicator).
- Per-block toggle controls in the UI: show/hide code, rerun-from-top.
- Execution output (text, figures, errors) displayed inline below the block.
- Arrow key navigation between code and prose (up/down to exit code cells).

### File Watching
- When the file changes on disk, the editor reloads content automatically (like Sublime Text).
- If the editor has unsaved changes when a disk change is detected, prompt the user to choose which version to keep.

### Image Handling
- **Drag-and-drop / paste**: drop an image onto the editor, app saves it to a project assets folder and inserts the relative path markdown automatically.
- **Click popover**: clicking a rendered image shows an editable popover with the file path and alt text fields.

### Document Outline
- Right sidebar showing heading hierarchy.
- Highlights the heading corresponding to the current scroll position.
- Click a heading to scroll to it.

## Editor Theme: LaTeX-Like Layout

The editor is styled to closely match the appearance of a LaTeX document, so the WYSIWYG editing experience visually matches the final output. This is the core design principle — what you see in the editor IS the document.

### Design Targets
- **Font**: Computer Modern Serif (CMU Serif) — the standard LaTeX body font
- **Text width**: ~6.5 inches (matching LaTeX default at 1in margins on letter paper)
- **Paragraph spacing**: matches LaTeX's `\parskip` behavior
- **Heading sizes**: matches LaTeX's `\section`, `\subsection`, etc. sizing
- **Math rendering**: KaTeX with Computer Modern math fonts (visually identical to LaTeX math)
- **Code blocks**: styled boxes with syntax highlighting, similar to `listings` or `minted` in LaTeX

### Why This Matters
Because the editor mimics LaTeX layout, the WYSIWYG print-to-PDF produces output that looks like a LaTeX document — without any LaTeX compilation. This eliminates the editor-export gap that plagues other tools (Quarto, Jupyter) where the editing view and the export look different.

## Export

pymd offers two export paths:

### 1. WYSIWYG Print-to-PDF (Primary, Cmd+P)

Prints the editor view directly to PDF via the browser/system print dialog. This is the primary export path because it produces exactly what you see in the editor.

- **Perfect fidelity** — the PDF IS the editor view, paginated
- **Code outputs included** — they're visible in the editor DOM and print naturally
- **Math rendered** — KaTeX output prints as-is
- **`{{variables}}`** — resolved values display and print
- **Hidden code blocks** — omitted from print via `@media print` CSS
- **Instant** — no LaTeX compilation wait
- **Page control** — `@page` CSS sets margins, headers/footers, page numbers

`@media print` CSS hides:
- Code cell buttons (run, hide, exec, delete, copy)
- Cell dividers (+Code / +Text)
- Block handles (drag, slash menu)
- Outline sidebar
- Raw markdown panel
- Connection status

### 2. Pandoc/LaTeX Export (Advanced, Cmd+E)

Exports via Pandoc for journal-quality PDF or standalone HTML. This is the path for when you need:
- LaTeX-quality micro-typography (hyphenation, ligatures, page-aware layout)
- Bibliography integration (BibTeX)
- Cross-references and auto-numbering
- Table of contents with page numbers
- Submission to a journal or conference

Process:
- Resolves `{{variables}}` from the execution namespace
- Strips `exec`/`hide`/`rerun` flags from code fences
- Converts `<br />` tags to `\vspace` for PDF or passes through for HTML
- Hidden code blocks: code omitted, output preserved
- LaTeX code blocks: converted back to `$$...$$` display math
- Runs Pandoc with XeLaTeX engine, Computer Modern fonts, custom tcolorbox header

Formats:
- **PDF** via XeLaTeX (requires MacTeX/TeX Live installed)
- **HTML** with MathJax for math rendering

### When to Use Which
| Use Case | Export Path |
|----------|------------|
| Teaching materials, handouts | Cmd+P (WYSIWYG) |
| Quick sharing | Cmd+P (WYSIWYG) |
| Exam documents | Cmd+P (WYSIWYG) |
| Technical reports | Either |
| Journal submissions | Cmd+E (Pandoc/LaTeX) |
| Documents with bibliography | Cmd+E (Pandoc/LaTeX) |

## Layout

### Three-Panel Layout
- **Left panel**: Document outline (collapsible). Shows heading hierarchy, highlights current position, click to navigate.
- **Center panel**: WYSIWYG editor. LaTeX-themed, max-width capped, centered on wide screens.
- **Right panel**: Raw markdown source (collapsible). Live two-way sync with the editor.

### File Associations
- pymd registers as a handler for `.md`, `.markdown`, `.mdown`, `.mkd` files on macOS
- Opening a file via Finder's "Open With" loads it in the editor
- macOS native title bar shows the filename

## CLI

```
pymd open file.md        # Launch the editor/viewer
pymd run file.md         # Execute all blocks, output results to terminal
pymd export file.md      # Export via Pandoc
```

`pymd run` on a file with no executable blocks prints:
```
Rendered file.md (0 executable blocks found)
```

## Post-MVP Features

- **Slides mode**: split document on `---` or heading boundaries, render as full-screen presentation with navigation.
- **Multi-window support**: each window gets its own Python sidecar with its own namespace.
- **Autosave**: debounced save to disk after editing (requires careful implementation to avoid editor re-renders).
- **Pandoc export**: PDF and HTML output.
- **Cell reordering**: drag to rearrange code blocks.
- **Virtual environment detection**: auto-detect and use project venvs.
- **Themes**: light/dark mode, customizable typography.
