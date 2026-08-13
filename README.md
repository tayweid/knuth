# Knuth (formerly pyrmd)

> Part of the Claerbout suite with [Plass](https://github.com/tayweid/plass).
> The v2 redesign lives in [DESIGN.md](./DESIGN.md); the README below
> describes the v1 Tauri app.

A WYSIWYG markdown editor with executable Python code cells. Combines Typora-style editing with Jupyter-style computation in a native desktop app.

- Write prose in a clean, distraction-free editor
- Execute Python code blocks inline with shared namespace
- Render LaTeX math (inline and display)
- Export to PDF or HTML via Pandoc
- Plain `.md` files — no proprietary format

Built with Tauri, Milkdown, CodeMirror, and KaTeX.

## Install

Download the latest release for your platform from [Releases](https://github.com/tayweid/pymd/releases).

**Requirements:** Python 3.11+ with the pymd server:

```bash
pip install pymd-server
```

## Build from source

```bash
# Prerequisites: Node.js 18+, Rust 1.70+, Python 3.11+

# Clone and install
git clone https://github.com/tayweid/pymd.git
cd pymd
npm install

# Install the Python sidecar
cd python && pip install -e . && cd ..

# Run in dev mode
npx tauri dev

# Build for release
npx tauri build
```

The built app will be in `src-tauri/target/release/bundle/`.

## File format

Documents are plain `.md` files. Code blocks with `python exec` are executable:

````markdown
# My Analysis

Some prose with **formatting** and $E = mc^2$ inline math.

$$
\int_0^\infty e^{-x} dx = 1
$$

```python exec
import pandas as pd
df = pd.read_csv('data.csv')
print(df.describe())
```

Variables persist across cells. Use `{{variable}}` for inline interpolation.
````

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Cmd+S | Save |
| Cmd+Shift+C | Insert code cell |
| Cmd+E | Export (PDF/HTML) |
| Shift+Enter | Run code cell |
| Cmd+Shift+Enter | Run all cells |

## License

MIT
