// The Kernel interface (KERNEL.md): everything the app needs from an
// execution backend. SidecarKernel is the v1 implementation; a Pyodide
// backend would implement the same surface.
//
// SidecarKernel reconnects forever: the sidecar may start after the page
// (or restart underneath it), so a lost/failed connection retries every
// 2s and status changes surface through onStatus. The server sends a
// `ready` snapshot to late-joining clients, so connecting at any time
// converges to 'ready'.
//
// The engine serves this page, so the socket goes back to the origin the
// page came from and needs no credential — the server's Origin check is
// the authentication (SAME_ORIGIN.md). A page restored from the service
// worker cache with no engine running simply retries until one appears.

import {
  PROTOCOL_VERSION,
  DocumentResult,
  PersistedResult,
  RenamedResult,
  SavedResult,
  StatResult,
  parseServerEvent,
  type Artifacts,
  type ConvertResult,
  type FigureResult,
  type NamespaceVar,
  type ServerEvent,
  type StreamWhich,
  type TableWindow,
} from './protocol.ts';

export { PROTOCOL_VERSION } from './protocol.ts';
export type {
  Artifacts,
  ConvertResult,
  DocumentResult,
  FigureResult,
  NamespaceVar,
  PersistedResult,
  RenamedResult,
  SavedResult,
  StatResult,
  StreamWhich,
  TableWindow,
} from './protocol.ts';

export type KernelStatus =
  | 'connecting'
  | 'ready'
  | 'down'
  | 'incompatible'
  /** The engine answered but is at its session limit. */
  | 'busy'
  /** The engine is fine; Python is what failed. */
  | 'kernel_failed';

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

export interface Kernel {
  /** Connected and past `ready`: requests will be answered now. */
  readonly isReady: boolean;
  run(code: string, handlers?: RunHandlers, opts?: { scratch?: boolean }): Promise<RunOutcome>;
  interrupt(): void;
  /** Fresh session; with a root, the session also moves to that folder. */
  restart(root?: string | null): Promise<void>;
  namespace(): Promise<NamespaceVar[]>;
  artifacts(): Promise<Artifacts | null>;
  table(name: string, offset?: number, limit?: number): Promise<TableWindow | null>;
  figure(name: string): Promise<FigureResult | null>;
  /** .ipynb JSON in, percent-format document text out (null: no engine). */
  convert(text: string): Promise<ConvertResult | null>;
  /** Documents by absolute path, read and written by the engine (APP.md).
   *  null: no engine connection. */
  openPath(path: string): Promise<DocumentResult | null>;
  savePath(path: string, text: string): Promise<SavedResult | null>;
  statPath(path: string): Promise<StatResult | null>;
  renamePath(path: string, name: string): Promise<RenamedResult | null>;
  /** The kernel writes values.json and figs/ into its own folder. */
  persist(): Promise<PersistedResult | null>;
  /** The folder this session's kernel runs in, as the engine reported it. */
  readonly root: string | null;
  close(): void;
}

/** The engine that served this page. Deriving it keeps the app working on
 *  whatever port the engine was started with, rather than a baked-in one. */
export function kernelUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}`;
}

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
  private retryTimer = 0;
  /** A refusal the engine explained. The close that follows it, and the
   *  retries after that, must not overwrite the explanation with a generic
   *  "engine unavailable" — that is how two different problems came to look
   *  identical. Cleared when a connection actually works. */
  private refused: KernelStatus | null = null;
  private nextId = 1;
  private runs = new Map<number, PendingRun>();
  private namespaceWaiters = new Map<number, (vars: NamespaceVar[]) => void>();
  private artifactsWaiters = new Map<number, (artifacts: Artifacts | null) => void>();
  private tableWaiters = new Map<number, (window: TableWindow | null) => void>();
  private figureWaiters = new Map<number, (result: FigureResult | null) => void>();
  private convertWaiters = new Map<number, (result: ConvertResult | null) => void>();
  private documentWaiters = new Map<number, (result: DocumentResult | null) => void>();
  private savedWaiters = new Map<number, (result: SavedResult | null) => void>();
  private statWaiters = new Map<number, (result: StatResult | null) => void>();
  private renamedWaiters = new Map<number, (result: RenamedResult | null) => void>();
  private persistedWaiters = new Map<number, (result: PersistedResult | null) => void>();
  private restartWaiters = new Map<number, () => void>();
  /** Where the kernel runs, as last reported by `attached`. */
  root: string | null = null;
  /** The root to ask for on the next attach: the document's folder. A
   *  resumed session keeps the kernel it has; a fresh one starts here. */
  private wantedRoot: string | null;
  constructor(
    private url: string = kernelUrl(),
    private onStatus?: (status: KernelStatus, resumed?: boolean) => void,
    root: string | null = null,
  ) {
    this.wantedRoot = root;
    this.connect();
  }

  get isReady(): boolean {
    return this.connectedReady;
  }

  /** One pending reconnect at a time: a second socket would fork a session. */
  private scheduleConnect(delay: number): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private connect(): void {
    clearTimeout(this.retryTimer);
    if (this.closed) return;
    if (!this.refused) this.onStatus?.('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('open', () =>
      ws.send(
        JSON.stringify({
          type: 'attach',
          protocol: PROTOCOL_VERSION,
          session: sessionId(),
          ...(this.wantedRoot ? { root: this.wantedRoot } : {}),
        }),
      ),
    );
    ws.addEventListener('message', (ev) => this.receive(ws, ev.data));
    // 'error' is always followed by 'close'; one path handles both.
    ws.addEventListener('close', () => this.dropped(ws));
  }

  private receive(ws: WebSocket, raw: unknown): void {
    if (this.ws !== ws) return;
    let decoded: unknown;
    try {
      if (typeof raw !== 'string') throw new Error('expected a text event');
      decoded = JSON.parse(raw) as unknown;
    } catch {
      this.rejectMalformedEvent(ws);
      return;
    }
    const event = parseServerEvent(decoded);
    if (!event) {
      this.rejectMalformedEvent(ws);
      return;
    }
    this.dispatch(event);
  }

  private rejectMalformedEvent(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.connectedReady = false;
    this.failPending('invalid event from the Python engine');
    this.onStatus?.('down');
    ws.close(1002, 'invalid kernel event');
  }

  private dropped(ws: WebSocket): void {
    // An older socket can finish closing after a replacement is already live.
    if (this.ws !== ws) return;
    this.ws = null;
    if (this.closed) return;
    this.connectedReady = false;
    this.failPending('kernel connection lost');
    if (!this.refused) this.onStatus?.('down');
    this.scheduleConnect(RECONNECT_MS);
  }

  private failPending(reason: string): void {
    for (const run of this.runs.values()) {
      run.resolve({ ok: false, result: null, traceback: reason });
    }
    this.runs.clear();
    for (const resolve of this.namespaceWaiters.values()) resolve([]);
    this.namespaceWaiters.clear();
    for (const resolve of this.artifactsWaiters.values()) resolve(null);
    this.artifactsWaiters.clear();
    for (const resolve of this.tableWaiters.values()) resolve(null);
    this.tableWaiters.clear();
    for (const resolve of this.figureWaiters.values()) resolve(null);
    this.figureWaiters.clear();
    for (const resolve of this.convertWaiters.values()) resolve(null);
    this.convertWaiters.clear();
    for (const resolve of this.documentWaiters.values()) resolve(null);
    this.documentWaiters.clear();
    for (const resolve of this.savedWaiters.values()) resolve(null);
    this.savedWaiters.clear();
    for (const resolve of this.statWaiters.values()) resolve(null);
    this.statWaiters.clear();
    for (const resolve of this.renamedWaiters.values()) resolve(null);
    this.renamedWaiters.clear();
    for (const resolve of this.persistedWaiters.values()) resolve(null);
    this.persistedWaiters.clear();
    for (const resolve of this.restartWaiters.values()) resolve();
    this.restartWaiters.clear();
  }

  private dispatch(msg: ServerEvent): void {
    switch (msg.type) {
      case 'attached': {
        const serverProtocol = msg.protocol;
        if (serverProtocol !== PROTOCOL_VERSION) {
          this.rejectIncompatible(serverProtocol);
          break;
        }
        // A duplicated tab forks: the server hands us a fresh identity.
        if (msg.session) sessionStorage.setItem('knuth-session', msg.session);
        this.root = msg.root ?? null;
        break;
      }
      case 'ready': {
        if (this.connectedReady) {
          // A ready while already ready is a completed restart: in-flight
          // runs died with the old process.
          const restartId = typeof msg.id === 'number' ? msg.id : null;
          const restarted = restartId === null ? undefined : this.restartWaiters.get(restartId);
          if (restartId !== null) this.restartWaiters.delete(restartId);
          this.failPending('kernel restarted');
          restarted?.();
        }
        this.connectedReady = true;
        this.refused = null;
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
        this.namespaceWaiters.get(msg.id)?.(msg.vars);
        this.namespaceWaiters.delete(msg.id);
        break;
      }
      case 'artifacts': {
        this.artifactsWaiters.get(msg.id)?.({ values: msg.values, figures: msg.figures });
        this.artifactsWaiters.delete(msg.id);
        break;
      }
      case 'table': {
        this.tableWaiters.get(msg.id)?.(msg);
        this.tableWaiters.delete(msg.id);
        break;
      }
      case 'figure': {
        this.figureWaiters.get(msg.id)?.(msg);
        this.figureWaiters.delete(msg.id);
        break;
      }
      case 'converted': {
        this.convertWaiters.get(msg.id)?.(msg);
        this.convertWaiters.delete(msg.id);
        break;
      }
      case 'document': {
        this.documentWaiters.get(msg.id)?.(msg);
        this.documentWaiters.delete(msg.id);
        break;
      }
      case 'saved': {
        this.savedWaiters.get(msg.id)?.(msg);
        this.savedWaiters.delete(msg.id);
        break;
      }
      case 'stat': {
        this.statWaiters.get(msg.id)?.(msg);
        this.statWaiters.delete(msg.id);
        break;
      }
      case 'renamed': {
        this.renamedWaiters.get(msg.id)?.(msg);
        this.renamedWaiters.delete(msg.id);
        break;
      }
      case 'persisted': {
        this.persistedWaiters.get(msg.id)?.(msg);
        this.persistedWaiters.delete(msg.id);
        break;
      }
      case 'protocol_error': {
        this.rejectRequest(msg);
        break;
      }
      case 'kernel_exit': {
        this.connectedReady = false;
        this.failPending(
          typeof msg.error === 'string' ? msg.error : 'Python engine exited unexpectedly',
        );
        this.refused = 'kernel_failed';
        this.onStatus?.('kernel_failed');
        this.ws?.close(1011, 'kernel process exited');
        break;
      }
      case 'kernel_start_failed': {
        this.connectedReady = false;
        this.failPending(msg.error);
        this.refused = 'kernel_failed';
        this.onStatus?.('kernel_failed');
        this.ws?.close(1011, 'kernel failed to start');
        break;
      }
      case 'server_busy': {
        this.connectedReady = false;
        this.failPending(msg.error);
        this.refused = 'busy';
        this.onStatus?.('busy');
        this.ws?.close(1013, 'kernel server busy');
        break;
      }
    }
  }

  private rejectRequest(msg: Extract<ServerEvent, { type: 'protocol_error' }>): void {
    const reason = msg.error;
    if (msg.id === undefined) return;
    switch (msg.request) {
      case 'run': {
        const pending = this.runs.get(msg.id);
        pending?.resolve({ ok: false, result: null, traceback: reason });
        this.runs.delete(msg.id);
        break;
      }
      case 'namespace':
        this.namespaceWaiters.get(msg.id)?.([]);
        this.namespaceWaiters.delete(msg.id);
        break;
      case 'artifacts':
        this.artifactsWaiters.get(msg.id)?.(null);
        this.artifactsWaiters.delete(msg.id);
        break;
      case 'table':
        this.tableWaiters.get(msg.id)?.(null);
        this.tableWaiters.delete(msg.id);
        break;
      case 'figure':
        this.figureWaiters.get(msg.id)?.(null);
        this.figureWaiters.delete(msg.id);
        break;
      case 'convert':
        this.convertWaiters.get(msg.id)?.({ error: reason });
        this.convertWaiters.delete(msg.id);
        break;
      case 'open':
        this.documentWaiters.get(msg.id)?.({ error: reason });
        this.documentWaiters.delete(msg.id);
        break;
      case 'save':
        this.savedWaiters.get(msg.id)?.({ error: reason });
        this.savedWaiters.delete(msg.id);
        break;
      case 'stat':
        this.statWaiters.get(msg.id)?.({ error: reason });
        this.statWaiters.delete(msg.id);
        break;
      case 'rename':
        this.renamedWaiters.get(msg.id)?.({ error: reason });
        this.renamedWaiters.delete(msg.id);
        break;
      case 'persist':
        this.persistedWaiters.get(msg.id)?.({ error: reason });
        this.persistedWaiters.delete(msg.id);
        break;
      case 'restart':
        this.restartWaiters.get(msg.id)?.();
        this.restartWaiters.delete(msg.id);
        break;
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

  /** A restart may move the session: opening a document in another
   *  folder is a new project, and its kernel belongs there. */
  async restart(root?: string | null): Promise<void> {
    if (root !== undefined) this.wantedRoot = root;
    if (!this.connectedReady) return;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.restartWaiters.set(id, resolve);
      this.send({ type: 'restart', id, ...(root ? { root } : {}) });
      if (root !== undefined) this.root = root;
    });
  }

  async namespace(): Promise<NamespaceVar[]> {
    if (!this.connectedReady) return [];
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.namespaceWaiters.set(id, resolve);
      this.send({ type: 'namespace', id });
    });
  }

  async artifacts(): Promise<Artifacts | null> {
    if (!this.connectedReady) return null;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.artifactsWaiters.set(id, resolve);
      this.send({ type: 'artifacts', id });
    });
  }

  async table(name: string, offset = 0, limit = 100): Promise<TableWindow | null> {
    if (!this.connectedReady) return null;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.tableWaiters.set(id, resolve);
      this.send({ type: 'table', id, name, offset, limit });
    });
  }

  async figure(name: string): Promise<FigureResult | null> {
    if (!this.connectedReady) return null;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.figureWaiters.set(id, resolve);
      this.send({ type: 'figure', id, name });
    });
  }

  async convert(text: string): Promise<ConvertResult | null> {
    if (!this.connectedReady) return null;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.convertWaiters.set(id, resolve);
      this.send({ type: 'convert', id, text });
    });
  }

  async openPath(path: string): Promise<DocumentResult | null> {
    if (!this.connectedReady) return null;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.documentWaiters.set(id, resolve);
      this.send({ type: 'open', id, path });
    });
  }

  async savePath(path: string, text: string): Promise<SavedResult | null> {
    if (!this.connectedReady) return null;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.savedWaiters.set(id, resolve);
      this.send({ type: 'save', id, path, text });
    });
  }

  async statPath(path: string): Promise<StatResult | null> {
    if (!this.connectedReady) return null;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.statWaiters.set(id, resolve);
      this.send({ type: 'stat', id, path });
    });
  }

  async renamePath(path: string, name: string): Promise<RenamedResult | null> {
    if (!this.connectedReady) return null;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.renamedWaiters.set(id, resolve);
      this.send({ type: 'rename', id, path, name });
    });
  }

  async persist(): Promise<PersistedResult | null> {
    if (!this.connectedReady) return null;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.persistedWaiters.set(id, resolve);
      this.send({ type: 'persist', id });
    });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}
