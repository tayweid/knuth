/**
 * WebSocket client for communicating with the Python sidecar server.
 */

type MessageHandler = (msg: ServerMessage) => void;

export interface ExecutionResult {
  block_id: string;
  stdout: string;
  stderr: string;
  error: string | null;
  figures: string[];
}

export type ServerMessage =
  | { type: "execution_result"; result: ExecutionResult; namespace: Record<string, string> }
  | { type: "execution_results"; results: ExecutionResult[]; namespace: Record<string, string> }
  | { type: "interpolation"; namespace: Record<string, string> }
  | { type: "file_changed" }
  | { type: "pong" }
  | { type: "ok" }
  | { type: "error"; message: string }
  | { type: "export_success"; path: string }
  | { type: "export_error"; error: string };

export interface BlockInfo {
  block_id: string;
  code: string;
}

class PymdClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, MessageHandler[]> = new Map();
  private pendingCallbacks: Map<number, (msg: ServerMessage) => void> = new Map();
  private messageId = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  connect(host = "127.0.0.1", port = 9742): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      this.ws = new WebSocket(`ws://${host}:${port}`);

      this.ws.onopen = () => {
        this._connected = true;
        this.emit({ type: "ok" }); // notify listeners of connection
        resolve();
      };

      this.ws.onclose = () => {
        this._connected = false;
        this.scheduleReconnect(host, port);
      };

      this.ws.onerror = () => {
        if (!this._connected) {
          reject(new Error("Failed to connect to pymd server"));
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as ServerMessage;
          this.emit(msg);
        } catch {
          // Ignore invalid messages
        }
      };
    });
  }

  private scheduleReconnect(host: string, port: number) {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(host, port).catch(() => {
        // Will retry via onclose
      });
    }, 2000);
  }

  private emit(msg: ServerMessage) {
    const typeHandlers = this.handlers.get(msg.type) || [];
    for (const handler of typeHandlers) {
      handler(msg);
    }
    // Also emit to wildcard handlers
    const wildcardHandlers = this.handlers.get("*") || [];
    for (const handler of wildcardHandlers) {
      handler(msg);
    }
  }

  on(type: string, handler: MessageHandler) {
    const existing = this.handlers.get(type) || [];
    existing.push(handler);
    this.handlers.set(type, existing);
  }

  off(type: string, handler: MessageHandler) {
    const existing = this.handlers.get(type) || [];
    this.handlers.set(
      type,
      existing.filter((h) => h !== handler)
    );
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Execute a single code block */
  executeBlock(blockId: string, code: string) {
    this.send({ type: "execute_block", block_id: blockId, code });
  }

  /** Execute all blocks top-to-bottom */
  executeAll(blocks: BlockInfo[]) {
    this.send({ type: "execute_all", blocks });
  }

  /** Execute blocks up to and including blockId */
  executeUpTo(blocks: BlockInfo[], blockId: string, rerun = false) {
    this.send({ type: "execute_up_to", blocks, block_id: blockId, rerun });
  }

  /** Request current namespace for interpolation */
  requestNamespace() {
    this.send({ type: "interpolate" });
  }

  /** Export document to HTML or PDF */
  exportDocument(markdown: string, outputPath: string, format: string, outputs: Record<string, any> = {}) {
    this.send({ type: "export", markdown, output_path: outputPath, format, outputs });
  }

  /** Tell sidecar to watch a file */
  watchFile(path: string) {
    this.send({ type: "watch_file", path });
  }

  /** Reset the execution namespace */
  reset() {
    this.send({ type: "reset" });
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }
}

/** Singleton client instance */
export const pymdClient = new PymdClient();
