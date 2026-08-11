import { useCallback, useEffect, useRef, useState } from "react";
import { MilkdownProvider } from "@milkdown/react";
import { NotebookEditor, NotebookEditorHandle } from "./components/NotebookEditor";
import { pymdClient } from "./services/pymdClient";
import { getCodeBlockOutputs, saveOutputCache, loadOutputCache } from "./plugins/codeMirrorBlock";
import { setNamespace } from "./plugins/interpolationPlugin";

export default function App() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [initialContent, setInitialContent] = useState<string>(
    `# Welcome to pymd

Start writing here. This is a **WYSIWYG** markdown editor with executable Python cells.

## Math Support

Inline math: $E = mc^2$

Display math:

$$
\\int_0^\\infty e^{-x} dx = 1
$$

Numbered equation:

$$
\\begin{align}
  E &= mc^2 \\\\
  F &= ma
\\end{align}
$$

## Executable Code

\`\`\`python exec
x = 42
print(f"The answer is {x}")
\`\`\`

\`\`\`python exec
import math
print(f"Pi is approximately {math.pi:.4f}")
\`\`\`

## Images

Drag and drop an image here, or click on any image to edit its path.
`
  );
  const [connected, setConnected] = useState(false);
  const dirtyRef = useRef(false);
  const [dirtyDisplay, setDirtyDisplay] = useState(false);
  const editorRef = useRef<NotebookEditorHandle>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filePathRef = useRef<string | null>(null);

  // Listen for file-open events (when user opens a .md file with pymd)
  useEffect(() => {
    const loadFile = async (path: string) => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<{ content: string; path: string }>("read_file", { path });
        setInitialContent(result.content);
        setFilePath(result.path);
        filePathRef.current = result.path;
        setTimeout(() => loadOutputCache(result.path), 1000);
      } catch (e) {
        console.error("Failed to open file:", e);
      }
    };

    // Listen for macOS open-with event (emitted from Rust)
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("file-opened", (event: any) => {
        const path = event.payload as string;
        if (path) loadFile(path);
      });
    }).catch(() => {});

    // Also check for CLI arguments (file passed as argument)
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke<string | null>("get_opened_file").then((path) => {
        if (path) loadFile(path);
      }).catch(() => {});
    }).catch(() => {});
  }, []);

  // Start Python sidecar and connect
  useEffect(() => {
    const startAndConnect = async () => {
      try {
        // Get sidecar port from Tauri (sidecar starts automatically on app launch)
        const { invoke } = await import("@tauri-apps/api/core");
        const port = await invoke<number>("get_sidecar_port");
        console.log(`pymd sidecar on port ${port}`);
        await pymdClient.connect("127.0.0.1", port);
        setConnected(true);
      } catch (err) {
        console.error("Sidecar connection failed:", err);
        // Not in Tauri or sidecar failed — try default port (manual server)
        pymdClient.connect().then(() => setConnected(true)).catch(() => {
          console.log("pymd server not available. Run: python -m pymd_server");
        });
      }
    };
    startAndConnect();

    // Listen for namespace updates after code execution, and save output cache
    const handleNamespace = (msg: any) => {
      if (msg.namespace) setNamespace(msg.namespace);
      // Save outputs after each execution
      if (filePathRef.current) {
        setTimeout(() => saveOutputCache(filePathRef.current!), 200);
      }
    };
    pymdClient.on("execution_result", handleNamespace);
    pymdClient.on("execution_results", handleNamespace);

    // Listen for file changes from the watcher
    const handleFileChanged = () => {
      if (filePath) {
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke<{ content: string; path: string }>("read_file", { path: filePath }).then(
            (result) => setInitialContent(result.content)
          );
        }).catch(() => {});
      }
    };
    pymdClient.on("file_changed", handleFileChanged);

    return () => {
      pymdClient.off("execution_result", handleNamespace);
      pymdClient.off("execution_results", handleNamespace);
      pymdClient.off("file_changed", handleFileChanged);
      pymdClient.disconnect();
    };
  }, []);

  // Tell sidecar to watch the file when it changes
  useEffect(() => {
    if (filePath && connected) {
      pymdClient.watchFile(filePath);
    }
  }, [filePath, connected]);

  const handleOpen = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        filters: [{ name: "Markdown", extensions: ["md", "qmd"] }],
      });
      if (path) {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<{ content: string; path: string }>("read_file", { path });
        setInitialContent(result.content);
        setFilePath(result.path);
        filePathRef.current = result.path;
        // Load cached outputs after editor renders
        setTimeout(() => loadOutputCache(result.path), 1000);
      }
    } catch {
      // Not running in Tauri
    }
  }, []);

  const handleSave = useCallback(
    async (content?: string) => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const md = content ?? editorRef.current?.getMarkdown() ?? "";
        let savePath = filePath;
        if (!savePath) {
          const { save } = await import("@tauri-apps/plugin-dialog");
          savePath = await save({
            filters: [{ name: "Markdown", extensions: ["md"] }],
          });
        }
        if (savePath) {
          await invoke("write_file", { path: savePath, content: md });
          setFilePath(savePath);
          filePathRef.current = savePath;
          dirtyRef.current = false;
          setDirtyDisplay(false);
        }
      } catch {
        // Not running in Tauri
      }
    },
    [filePath]
  );

  // Autosave: debounced save 2 seconds after last edit
  // Uses refs to avoid re-renders and editor recreation
  const handleContentChange = useCallback(() => {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      setDirtyDisplay(true);
    }
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      const path = filePathRef.current;
      if (path) {
        const md = editorRef.current?.getMarkdown() ?? "";
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("write_file", { path, content: md }).then(() => {
            dirtyRef.current = false;
            setDirtyDisplay(false);
          });
        }).catch(() => {});
      }
    }, 2000);
  }, []);

  // Export document via Pandoc
  const handleExport = useCallback(async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      // Default to same name/directory as the source file
      const sourceFile = filePathRef.current || "Untitled";
      const baseName = sourceFile.replace(/\.[^.]+$/, "");
      const defaultExportPath = `${baseName}.pdf`;

      const outputPath = await save({
        defaultPath: defaultExportPath,
        filters: [
          { name: "PDF", extensions: ["pdf"] },
          { name: "HTML", extensions: ["html"] },
        ],
      });
      if (!outputPath) return;

      const format = outputPath.endsWith(".pdf") ? "pdf" : "html";
      const markdown = editorRef.current?.getRenderedMarkdown() ?? editorRef.current?.getMarkdown() ?? "";

      // Listen for export result
      const handler = (msg: any) => {
        if (msg.type === "export_success") {
          console.log("Exported to:", msg.path);
          // Open the file
          import("@tauri-apps/api/core").then(({ invoke }) => {
            invoke("plugin:shell|open", { path: msg.path }).catch(() => {});
          });
        } else if (msg.type === "export_error") {
          console.error("Export failed:", msg.error);
        }
        pymdClient.off("export_success", handler);
        pymdClient.off("export_error", handler);
      };
      pymdClient.on("export_success", handler);
      pymdClient.on("export_error", handler);

      const outputs = getCodeBlockOutputs();
      pymdClient.exportDocument(markdown, outputPath, format, outputs);
    } catch {
      // Not in Tauri
    }
  }, []);

  // Cmd+E to export, Cmd+P to print
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "e") {
        e.preventDefault();
        handleExport();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleExport]);

  // Set native window title to filename + connection status
  useEffect(() => {
    const filename = filePath ? filePath.split("/").pop() || "Untitled" : "Untitled";
    const status = connected ? "✦" : "✧";
    const dirtyDot = dirtyDisplay ? " ●" : "";
    const title = `${filename}${dirtyDot}  ${status}`;
    document.title = title;
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke("set_window_title", { title });
    }).catch(() => {});
  }, [filePath, connected, dirtyDisplay]);

  return (
    <div className="app">
      <MilkdownProvider>
        <NotebookEditor
          ref={editorRef}
          initialContent={initialContent}
          onSave={handleSave}
          onContentChange={handleContentChange}
        />
      </MilkdownProvider>
    </div>
  );
}
