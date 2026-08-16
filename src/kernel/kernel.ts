// The Kernel interface (KERNEL.md): everything the app needs from an
// execution backend. SidecarKernel is the v1 implementation; a Pyodide
// backend would implement the same surface.
//
// SidecarKernel reconnects forever: the sidecar may start after the page
// (or restart underneath it), so a lost/failed connection retries every
// 2s and status changes surface through onStatus. The server sends a
// `ready` snapshot to late-joining clients, so connecting at any time
// converges to 'ready'.

export type StreamWhich = 'stdout' | 'stderr';
export type KernelStatus = 'connecting' | 'ready' | 'down' | 'incompatible';

export interface RunHandlers {
  onStream?(which: StreamWhich, text: string): void;
  /** Open pyplot figures at run end rendered to SVG, plus the canonical
   *  names of figures this run touched (for figs/<name>.svg receipts). */
  onFigures?(svgs: string[], named: string[]): void;
}

export interface RunOutcome {
  ok: boolean;
  /** repr of the cell's last expression (null if none) when ok. */
  result: string | null;
  /** Formatted traceback (or connection failure reason) when not ok. */
  traceback: string | null;
}

export interface NamespaceVar {
  name: string;
  type: string;
  shape?: number[];
  length?: number;
  preview: string;
  /** Bound by a scratch cell: session-only, never persisted. */
  scratch?: boolean;
  /** A figure (or artist with one) sits behind this name. */
  figure?: boolean;
}

export interface FigureResult {
  name: string;
  svg?: string;
  error?: string;
}

export interface Artifacts {
  /** JSON-safe namespace mirror destined for values.json. */
  values: Record<string, unknown>;
  /** Named figures as SVG text, destined for figs/<name>.svg. */
  figures: Record<string, string>;
}

export interface TableWindow {
  name: string;
  error?: string;
  columns?: string[];
  index?: string[];
  rows?: string[][];
  total_rows?: number;
  total_cols?: number;
  offset?: number;
}

export interface Kernel {
  run(code: string, handlers?: RunHandlers, opts?: { scratch?: boolean }): Promise<RunOutcome>;
  interrupt(): void;
  restart(): Promise<void>;
  namespace(): Promise<NamespaceVar[]>;
  artifacts(): Promise<Artifacts | null>;
  table(name: string, offset?: number, limit?: number): Promise<TableWindow | null>;
  figure(name: string): Promise<FigureResult | null>;
  close(): void;
}

export const DEFAULT_KERNEL_URL = 'ws://127.0.0.1:5197';
export const PROTOCOL_VERSION = 1;
const RECONNECT_MS = 2000;

interface PendingRun {
  handlers?: RunHandlers;
  resolve(outcome: RunOutcome): void;
}

// The session id lives in sessionStorage: it survives reloads of THIS tab
// but is never shared with a new window — exactly a session's lifetime.
// The server holds a disconnected session for a grace period, so reload,
// sleep, or a network blip reattaches instead of losing the namespace.
function sessionId(): string {
  let id = sessionStorage.getItem('knuth-session');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('knuth-session', id);
  }
  return id;
}

export class SidecarKernel implements Kernel {
  private ws: WebSocket | null = null;
  private connectedReady = false;
  private closed = false;
  private nextId = 1;
  private runs = new Map<number, PendingRun>();
  private namespaceWaiters: Array<(vars: NamespaceVar[]) => void> = [];
  private artifactsWaiters: Array<(artifacts: Artifacts | null) => void> = [];
  private tableWaiters: Array<(window: TableWindow | null) => void> = [];
  private figureWaiters: Array<(result: FigureResult | null) => void> = [];
  private restartWaiters: Array<() => void> = [];

  constructor(
    private url: string = DEFAULT_KERNEL_URL,
    private onStatus?: (status: KernelStatus, resumed?: boolean) => void,
  ) {
    this.connect();
  }

  get isReady(): boolean {
    return this.connectedReady;
  }

  private connect(): void {
    if (this.closed) return;
    this.onStatus?.('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('open', () =>
      ws.send(
        JSON.stringify({
          type: 'attach',
          protocol: PROTOCOL_VERSION,
          session: sessionId(),
        }),
      ),
    );
    ws.addEventListener('message', (ev) => this.dispatch(JSON.parse(ev.data)));
    // 'error' is always followed by 'close'; one path handles both.
    ws.addEventListener('close', () => this.dropped());
  }

  private dropped(): void {
    if (this.closed) return;
    this.connectedReady = false;
    this.failPending('kernel connection lost');
    this.onStatus?.('down');
    setTimeout(() => this.connect(), RECONNECT_MS);
  }

  private failPending(reason: string): void {
    for (const run of this.runs.values()) {
      run.resolve({ ok: false, result: null, traceback: reason });
    }
    this.runs.clear();
    for (const resolve of this.namespaceWaiters.splice(0)) resolve([]);
    for (const resolve of this.artifactsWaiters.splice(0)) resolve(null);
    for (const resolve of this.tableWaiters.splice(0)) resolve(null);
    for (const resolve of this.figureWaiters.splice(0)) resolve(null);
    for (const resolve of this.restartWaiters.splice(0)) resolve();
  }

  private dispatch(msg: any): void {
    switch (msg.type) {
      case 'attached': {
        // A missing field is the one-release legacy-v1 compatibility path.
        const serverProtocol = msg.protocol ?? PROTOCOL_VERSION;
        if (serverProtocol !== PROTOCOL_VERSION) {
          this.rejectIncompatible(serverProtocol);
          break;
        }
        // A duplicated tab forks: the server hands us a fresh identity.
        if (msg.session) sessionStorage.setItem('knuth-session', msg.session);
        break;
      }
      case 'incompatible': {
        this.rejectIncompatible(msg.protocol);
        break;
      }
      case 'ready': {
        if (this.connectedReady) {
          // A ready while already ready is a completed restart: in-flight
          // runs died with the old process.
          this.failPending('kernel restarted');
        }
        this.connectedReady = true;
        for (const resolve of this.restartWaiters.splice(0)) resolve();
        this.onStatus?.('ready', msg.resumed === true);
        break;
      }
      case 'stream': {
        this.runs.get(msg.id)?.handlers?.onStream?.(msg.which, msg.text);
        break;
      }
      case 'figures': {
        this.runs.get(msg.id)?.handlers?.onFigures?.(msg.svgs ?? [], msg.named ?? []);
        break;
      }
      case 'done': {
        this.runs.get(msg.id)?.resolve({ ok: true, result: msg.result, traceback: null });
        this.runs.delete(msg.id);
        break;
      }
      case 'error': {
        this.runs.get(msg.id)?.resolve({ ok: false, result: null, traceback: msg.traceback });
        this.runs.delete(msg.id);
        break;
      }
      case 'namespace': {
        this.namespaceWaiters.shift()?.(msg.vars);
        break;
      }
      case 'artifacts': {
        this.artifactsWaiters.shift()?.({ values: msg.values, figures: msg.figures });
        break;
      }
      case 'table': {
        this.tableWaiters.shift()?.(msg);
        break;
      }
      case 'figure': {
        this.figureWaiters.shift()?.(msg);
        break;
      }
    }
  }

  private rejectIncompatible(serverProtocol: unknown): void {
    this.closed = true;
    this.connectedReady = false;
    this.failPending(
      `incompatible kernel protocol (app ${PROTOCOL_VERSION}, server ${String(serverProtocol)})`,
    );
    this.onStatus?.('incompatible');
    this.ws?.close(1002, 'unsupported protocol version');
  }

  private send(msg: object): void {
    this.ws!.send(JSON.stringify(msg));
  }

  async run(
    code: string,
    handlers?: RunHandlers,
    opts?: { scratch?: boolean },
  ): Promise<RunOutcome> {
    if (!this.connectedReady) {
      return { ok: false, result: null, traceback: 'no kernel connection' };
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.runs.set(id, { handlers, resolve });
      this.send({ type: 'run', id, code, scratch: opts?.scratch ?? false });
    });
  }

  interrupt(): void {
    if (this.connectedReady) this.send({ type: 'interrupt' });
  }

  async restart(): Promise<void> {
    if (!this.connectedReady) return;
    return new Promise((resolve) => {
      this.restartWaiters.push(resolve);
      this.send({ type: 'restart' });
    });
  }

  async namespace(): Promise<NamespaceVar[]> {
    if (!this.connectedReady) return [];
    return new Promise((resolve) => {
      this.namespaceWaiters.push(resolve);
      this.send({ type: 'namespace' });
    });
  }

  async artifacts(): Promise<Artifacts | null> {
    if (!this.connectedReady) return null;
    return new Promise((resolve) => {
      this.artifactsWaiters.push(resolve);
      this.send({ type: 'artifacts' });
    });
  }

  async table(name: string, offset = 0, limit = 100): Promise<TableWindow | null> {
    if (!this.connectedReady) return null;
    return new Promise((resolve) => {
      this.tableWaiters.push(resolve);
      this.send({ type: 'table', name, offset, limit });
    });
  }

  async figure(name: string): Promise<FigureResult | null> {
    if (!this.connectedReady) return null;
    return new Promise((resolve) => {
      this.figureWaiters.push(resolve);
      this.send({ type: 'figure', name });
    });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
