interface ToolbarProps {
  filePath: string | null;
  connected: boolean;
  onOpen: () => void;
  onSave: (content?: string) => void;
}

export function Toolbar({ filePath, connected, onOpen, onSave }: ToolbarProps) {
  const filename = filePath ? filePath.split("/").pop() : "Untitled";

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <button className="toolbar-btn" onClick={onOpen}>
          Open
        </button>
        <button className="toolbar-btn" onClick={() => onSave()}>
          Save
        </button>
      </div>
      <div className="toolbar-center">
        <span className="toolbar-filename">{filename}</span>
        <span className={`toolbar-status ${connected ? "toolbar-status-on" : ""}`}>
          {connected ? "connected" : "offline"}
        </span>
      </div>
      <div className="toolbar-right" />
    </div>
  );
}
