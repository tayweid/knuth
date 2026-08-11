"""
WebSocket server for pymd.

Handles communication between the Tauri frontend and the Python executor.
Launched as a sidecar process by the Tauri app.

Also serves cached figures over HTTP so the webview can display them.
"""

import asyncio
import json
import sys
import base64
from pathlib import Path

try:
    import websockets
    from websockets.asyncio.server import serve
except ImportError:
    print("ERROR: websockets package required. Install with: pip install websockets", file=sys.stderr)
    sys.exit(1)

from .executor import Executor
from .watcher import FileWatcher


class PymdServer:
    def __init__(self, host: str = "127.0.0.1", port: int = 9742):
        self.host = host
        self.port = port
        # Use a writable directory for cache — home dir or temp
        cache_dir = Path.home() / ".pymd_cache" / str(port)
        self.executor = Executor(cache_dir=cache_dir)
        self.watcher = FileWatcher()
        self._ws = None

    def _encode_figures(self, result_dict: dict) -> dict:
        """Replace figure file paths with base64 data URIs."""
        encoded = []
        for fig_path in result_dict.get("figures", []):
            path = Path(fig_path)
            if path.exists():
                data = base64.b64encode(path.read_bytes()).decode("ascii")
                encoded.append(f"data:image/png;base64,{data}")
            else:
                encoded.append(fig_path)
        result_dict["figures"] = encoded
        return result_dict

    async def handle_message(self, message: str) -> str:
        """Process a message from the frontend and return a response."""
        try:
            msg = json.loads(message)
        except json.JSONDecodeError:
            return json.dumps({"type": "error", "message": "Invalid JSON"})

        msg_type = msg.get("type", "")

        if msg_type == "execute_block":
            result = self.executor.execute_block(msg["block_id"], msg["code"])
            namespace = self.executor.get_namespace_snapshot()
            return json.dumps({
                "type": "execution_result",
                "result": self._encode_figures(result.to_dict()),
                "namespace": namespace,
            })

        elif msg_type == "execute_all":
            blocks = [(b["block_id"], b["code"]) for b in msg["blocks"]]
            results = self.executor.execute_blocks(blocks, rerun=True)
            namespace = self.executor.get_namespace_snapshot()
            return json.dumps({
                "type": "execution_results",
                "results": [self._encode_figures(r.to_dict()) for r in results],
                "namespace": namespace,
            })

        elif msg_type == "execute_up_to":
            blocks = [(b["block_id"], b["code"]) for b in msg["blocks"]]
            rerun = msg.get("rerun", False)
            results = self.executor.execute_blocks(
                blocks, up_to=msg["block_id"], rerun=rerun
            )
            namespace = self.executor.get_namespace_snapshot()
            return json.dumps({
                "type": "execution_results",
                "results": [self._encode_figures(r.to_dict()) for r in results],
                "namespace": namespace,
            })

        elif msg_type == "interpolate":
            namespace = self.executor.get_namespace_snapshot()
            return json.dumps({
                "type": "interpolation",
                "namespace": namespace,
            })

        elif msg_type == "watch_file":
            path = msg.get("path")
            if path:
                self.watcher.watch(path, self._notify_file_changed)
            return json.dumps({"type": "ok"})

        elif msg_type == "export":
            markdown = msg.get("markdown", "")
            output_path = msg.get("output_path", "")
            fmt = msg.get("format", "html")
            outputs = msg.get("outputs", {})  # {block_index: {stdout, error, figures}}
            result = self._export_document(markdown, output_path, fmt, outputs)
            return json.dumps(result)

        elif msg_type == "reset":
            self.executor.reset()
            return json.dumps({"type": "ok"})

        elif msg_type == "ping":
            return json.dumps({"type": "pong"})

        else:
            return json.dumps({"type": "error", "message": f"Unknown message type: {msg_type}"})

    def _export_document(self, markdown: str, output_path: str, fmt: str, outputs: dict = None) -> dict:
        """Export markdown to HTML or PDF via Pandoc."""
        import subprocess
        import tempfile
        import re
        import os

        if outputs is None:
            outputs = {}

        # 1. Resolve {{variables}}
        namespace = self.executor.get_namespace_snapshot()
        def replace_var(match):
            key = match.group(1).strip()
            return namespace.get(key, match.group(0))
        resolved = re.sub(r'\{\{(.+?)\}\}', replace_var, markdown)

        # 2. Process code blocks
        lines = resolved.split("\n")
        output_lines = []
        i = 0
        exec_block_index = 0

        while i < len(lines):
            line = lines[i]

            match = re.match(r'^```(\w+)(.*)$', line)
            if match:
                lang = match.group(1)
                flags_str = match.group(2).strip()
                flags = set(flags_str.split()) if flags_str else set()

                # Collect code block content
                code_lines = []
                i += 1
                while i < len(lines) and not lines[i].startswith("```"):
                    code_lines.append(lines[i])
                    i += 1
                if i < len(lines):
                    i += 1

                # LaTeX blocks → display math
                if lang.lower() == "latex":
                    code_content = "\n".join(code_lines).strip()
                    # If it contains \begin{...}, output raw (it's already a math env)
                    if code_content.startswith("\\begin{"):
                        output_lines.append("")
                        output_lines.extend(code_lines)
                        output_lines.append("")
                    else:
                        output_lines.append("$$")
                        output_lines.extend(code_lines)
                        output_lines.append("$$")
                    output_lines.append("")
                    continue

                is_exec = "exec" in flags or (lang.lower() == "python" and "static" not in flags)

                # Check hidden state from UI (passed via outputs) or from flags
                block_output = outputs.get(str(exec_block_index), {})
                is_hidden = "hide" in flags or block_output.get("hidden", False)

                # Hidden blocks: omit code but keep output
                if is_hidden:
                    if is_exec:
                        block_out = outputs.get(str(exec_block_index), {})
                        stdout = block_out.get("stdout", "")
                        error = block_out.get("error", "")
                        figures = block_out.get("figures", [])
                        if stdout:
                            output_lines.append("```")
                            output_lines.append(stdout.rstrip())
                            output_lines.append("```")
                            output_lines.append("")
                        if error:
                            output_lines.append("```")
                            output_lines.append(error.rstrip())
                            output_lines.append("```")
                            output_lines.append("")
                        for fig in figures:
                            if fig.startswith("data:"):
                                import base64 as b64mod
                                header, data = fig.split(",", 1)
                                fig_bytes = b64mod.b64decode(data)
                                fig_path = self.executor.figures_dir / f"export_hidden_{exec_block_index}.png"
                                fig_path.write_bytes(fig_bytes)
                                output_lines.append(f"![Output]({fig_path})")
                            else:
                                output_lines.append(f"![Output]({fig})")
                            output_lines.append("")
                    exec_block_index += 1
                    continue

                # Include code (without flags)
                output_lines.append(f"```{lang}")
                output_lines.extend(code_lines)
                output_lines.append("```")
                output_lines.append("")

                # Include cached output if it was run (don't re-execute)
                if is_exec:
                    block_output = outputs.get(str(exec_block_index), {})
                    stdout = block_output.get("stdout", "")
                    error = block_output.get("error", "")
                    figures = block_output.get("figures", [])

                    if stdout:
                        output_lines.append("```")
                        output_lines.append(stdout.rstrip())
                        output_lines.append("```")
                        output_lines.append("")
                    if error:
                        output_lines.append("```")
                        output_lines.append(error.rstrip())
                        output_lines.append("```")
                        output_lines.append("")
                    for fig in figures:
                        if fig.startswith("data:"):
                            # Base64 figure — save to temp file for Pandoc
                            import base64 as b64mod
                            header, data = fig.split(",", 1)
                            fig_bytes = b64mod.b64decode(data)
                            fig_path = self.executor.figures_dir / f"export_{exec_block_index}.png"
                            fig_path.write_bytes(fig_bytes)
                            output_lines.append(f"![Output]({fig_path})")
                        else:
                            output_lines.append(f"![Output]({fig})")
                        output_lines.append("")
                    exec_block_index += 1
            else:
                output_lines.append(line)
                i += 1

        resolved = "\n".join(output_lines)

        # Convert <br /> tags to vertical space
        if fmt == "pdf":
            # Replace each <br /> with a non-empty blank paragraph that LaTeX respects
            resolved = re.sub(r'<br\s*/?>', '\n\n\\ \n\n', resolved)
        # For HTML, <br /> tags pass through naturally

        # 3. Write resolved markdown to a temp file
        with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
            f.write(resolved)
            temp_md = f.name

        # 4. Build Pandoc command
        # Find pandoc — check common locations since Tauri doesn't inherit shell PATH
        import shutil
        pandoc = shutil.which("pandoc")
        if not pandoc:
            for p in ["/opt/anaconda3/bin/pandoc", "/opt/homebrew/bin/pandoc", "/usr/local/bin/pandoc"]:
                if Path(p).exists():
                    pandoc = p
                    break
        if not pandoc:
            import os
            os.unlink(temp_md)
            return {"type": "export_error", "error": "Pandoc not found. Install with: brew install pandoc"}

        cmd = [pandoc, temp_md, "-o", output_path, "--standalone"]
        print(f"[pymd export] format={fmt} output={output_path}", file=sys.stderr)

        if fmt == "html":
            cmd.extend([
                "--to", "html",
                "--mathjax",
                "--css", "https://cdn.jsdelivr.net/npm/computer-modern@0.1.2/cmu-serif.css",
                "--metadata", "title=",
            ])
        elif fmt == "pdf":
            # Find xelatex
            xelatex = None
            import shutil as shutil2
            xelatex = shutil2.which("xelatex")
            if not xelatex:
                for p in ["/Library/TeX/texbin/xelatex", "/usr/local/texlive/2025/bin/universal-darwin/xelatex"]:
                    if Path(p).exists():
                        xelatex = p
                        break
            if not xelatex:
                import os
                os.unlink(temp_md)
                return {"type": "export_error", "error": "XeLaTeX not found. Install with: brew install --cask mactex-no-gui"}
            # Find the header file (next to this script)
            header_path = Path(__file__).parent / "export_header.tex"
            cmd.extend([
                "--to", "pdf",
                f"--pdf-engine={xelatex}",
                "-V", "geometry:margin=1in",
                "--highlight-style", "tango",
                "-V", "colorlinks=true",
            ])
            if header_path.exists():
                cmd.extend(["-H", str(header_path)])

        # 5. Run Pandoc
        print(f"[pymd export] cmd: {' '.join(cmd)}", file=sys.stderr)
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120,
            )
            # Clean up temp file
            import os
            os.unlink(temp_md)

            print(f"[pymd export] returncode={result.returncode}", file=sys.stderr)
            if result.stderr:
                print(f"[pymd export] stderr: {result.stderr[:500]}", file=sys.stderr)

            if result.returncode != 0:
                return {"type": "export_error", "error": result.stderr}

            # 6. For HTML, inject custom styles
            if fmt == "html" and output_path.endswith(".html"):
                with open(output_path, 'r') as f:
                    html = f.read()
                custom_inject = """
<script>
  // Enable MathJax equation numbering
  window.MathJax = {
    tex: {
      tags: 'ams',
      tagSide: 'right'
    }
  };
</script>
<style>
  body {
    font-family: 'Computer Modern Serif', 'CMU Serif', Georgia, serif;
    max-width: 800px;
    margin: 0 auto;
    padding: 40px 20px;
    line-height: 1.7;
    color: #1a1a1a;
  }
  pre {
    background: #f6f8fa;
    border: 1px solid #e1e4e8;
    border-radius: 6px;
    padding: 12px 16px;
    overflow-x: auto;
  }
  code {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.88em;
  }
  img { max-width: 100%; }
</style>
"""
                # MathJax config must come BEFORE the MathJax script
                html = html.replace("<script", custom_inject + "\n<script", 1)
                with open(output_path, 'w') as f:
                    f.write(html)

            return {"type": "export_success", "path": output_path}

        except subprocess.TimeoutExpired:
            return {"type": "export_error", "error": "Export timed out after 30 seconds"}
        except Exception as e:
            return {"type": "export_error", "error": str(e)}

    def _notify_file_changed(self):
        """Send file_changed notification to frontend."""
        if self._ws:
            asyncio.ensure_future(
                self._ws.send(json.dumps({"type": "file_changed"}))
            )

    async def handler(self, websocket):
        """Handle a WebSocket connection."""
        self._ws = websocket
        try:
            async for message in websocket:
                response = await self.handle_message(message)
                await websocket.send(response)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self._ws = None
            self.watcher.stop()

    async def start(self):
        """Start the WebSocket server."""
        print(f"pymd server listening on ws://{self.host}:{self.port}", file=sys.stderr)
        async with serve(self.handler, self.host, self.port):
            await asyncio.Future()  # run forever


def main():
    """Entry point for the pymd server."""
    import argparse

    parser = argparse.ArgumentParser(description="pymd Python sidecar server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9742)
    args = parser.parse_args()

    server = PymdServer(host=args.host, port=args.port)
    asyncio.run(server.start())


if __name__ == "__main__":
    main()
