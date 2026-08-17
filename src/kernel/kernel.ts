// The Kernel interface (KERNEL.md): everything the app needs from an
// execution backend. SidecarKernel is the v1 implementation; a Pyodide
// backend would implement the same surface.
//
// SidecarKernel reconnects forever: the sidecar may start after the page
// (or restart underneath it), so a lost/failed connection retries every
// 2s and status changes surface through onStatus. The server sends a
// `ready` snapshot to late-joining clients, so connecting at any time
// converges to 'ready'. An unpaired window retries too, just slowly and
// quietly, because pairing can complete somewhere this window never hears
// about — and an OS file-handler launch opens exactly such a window.

export type StreamWhich = 'stdout' | 'stderr';
export type KernelStatus =
  | 'connecting'
  | 'ready'
  | 'down'
  | 'incompatible'
  | 'unauthorized'
  | 'pairing_expired';

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
export const PROTOCOL_VERSION = 2;
const RECONNECT_MS = 2000;
// Pairing is a human step, so retrying it fast would only churn. Retrying it
// never is worse: an OS file-handler launch opens an unpaired window that no
// storage event may ever reach, and today that window stays dead until a
// reload. A slow retry lets pairing done anywhere else eventually land.
const PAIRING_RETRY_MS = 15000;
const CAPABILITY_KEY = 'knuth-agent-capability';

function consumePairingFragment(): string | null {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const pairing = fragment.get('pair');
  if (pairing === null) return null;

  // Fragments are not sent to the web host, and removing this one immediately
  // keeps the short-lived token out of later screenshots and copied links.
  fragment.delete('pair');
  const rest = fragment.toString();
  history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`,
  );
  const normalized = pairing.trim();
  return normalized && normalized.length <= 256 ? normalized : null;
}

interface PendingRun {
  handlers?: RunHandlers;
  resolve(outcome: RunOutcome): void;
}

type ServerEvent =
  | { type: 'attached'; protocol: number; session: string; resumed: boolean }
  | { type: 'paired'; protocol: number; capability: string }
  | { type: 'incompatible'; protocol: number }
  | { type: 'unauthorized' }
  | { type: 'pairing_expired' }
  | { type: 'ready'; resumed?: boolean; id?: number }
  | { type: 'stream'; id: number; which: StreamWhich; text: string }
  | { type: 'figures'; id: number; svgs: string[]; named: string[] }
  | { type: 'done'; id: number; result: string | null }
  | { type: 'error'; id: number; traceback: string }
  | { type: 'namespace'; id: number; vars: NamespaceVar[] }
  | { type: 'artifacts'; id: number; values: Record<string, unknown>; figures: Record<string, string> }
  | ({ type: 'table'; id: number } & TableWindow)
  | ({ type: 'figure'; id: number } & FigureResult)
  | { type: 'protocol_error'; error: string; request?: string; id?: number }
  | { type: 'kernel_exit'; error: string; returncode?: number; id?: number }
  | { type: 'server_busy'; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNamespaceVar(value: unknown): value is NamespaceVar {
  if (!isRecord(value)) return false;
  if (
    typeof value.name !== 'string' ||
    typeof value.type !== 'string' ||
    typeof value.preview !== 'string'
  ) return false;
  if (value.shape !== undefined && (
    !Array.isArray(value.shape) ||
    !value.shape.every((item) => typeof item === 'number' && Number.isSafeInteger(item))
  )) return false;
  if (value.length !== undefined && !isRequestId(value.length)) return false;
  if (value.scratch !== undefined && typeof value.scratch !== 'boolean') return false;
  return value.figure === undefined || typeof value.figure === 'boolean';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function parseServerEvent(value: unknown): ServerEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  const event = value;
  switch (event.type) {
    case 'attached':
      return typeof event.protocol === 'number' && typeof event.session === 'string' &&
        typeof event.resumed === 'boolean' ? event as ServerEvent : null;
    case 'paired':
      return typeof event.protocol === 'number' && typeof event.capability === 'string'
        ? event as ServerEvent : null;
    case 'incompatible':
      return typeof event.protocol === 'number' ? event as ServerEvent : null;
    case 'unauthorized':
    case 'pairing_expired':
      return event as ServerEvent;
    case 'ready':
      return (event.resumed === undefined || typeof event.resumed === 'boolean') &&
        (event.id === undefined || isRequestId(event.id)) ? event as ServerEvent : null;
    case 'stream':
      return isRequestId(event.id) && (event.which === 'stdout' || event.which === 'stderr') &&
        typeof event.text === 'string' ? event as ServerEvent : null;
    case 'figures':
      return isRequestId(event.id) && isStringArray(event.svgs) && isStringArray(event.named)
        ? event as ServerEvent : null;
    case 'done':
      return isRequestId(event.id) && (event.result === null || typeof event.result === 'string')
        ? event as ServerEvent : null;
    case 'error':
      return isRequestId(event.id) && typeof event.traceback === 'string'
        ? event as ServerEvent : null;
    case 'namespace':
      return isRequestId(event.id) && Array.isArray(event.vars) && event.vars.every(isNamespaceVar)
        ? event as ServerEvent : null;
    case 'artifacts':
      return isRequestId(event.id) && isRecord(event.values) && isStringRecord(event.figures)
        ? event as ServerEvent : null;
    case 'figure':
      return isRequestId(event.id) && typeof event.name === 'string' &&
        optionalString(event.svg) && optionalString(event.error) ? event as ServerEvent : null;
    case 'table':
      return isRequestId(event.id) && typeof event.name === 'string' &&
        optionalString(event.error) && optionalStringArray(event.columns) &&
        optionalStringArray(event.index) &&
        (event.rows === undefined || (
          Array.isArray(event.rows) && event.rows.every(isStringArray)
        )) &&
        (event.total_rows === undefined || isRequestId(event.total_rows)) &&
        (event.total_cols === undefined || isRequestId(event.total_cols)) &&
        (event.offset === undefined || isRequestId(event.offset)) ? event as ServerEvent : null;
    case 'protocol_error':
      return typeof event.error === 'string' && optionalString(event.request) &&
        (event.id === undefined || isRequestId(event.id)) ? event as ServerEvent : null;
    case 'kernel_exit':
      return typeof event.error === 'string' &&
        (event.returncode === undefined || typeof event.returncode === 'number') &&
        (event.id === undefined || isRequestId(event.id)) ? event as ServerEvent : null;
    case 'server_busy':
      return typeof event.error === 'string' ? event as ServerEvent : null;
    default:
      return null;
  }
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
  private awaitingPair = false;
  private reattachAfterClose = false;
  private pairingToken = consumePairingFragment();
  /** The credential this socket presented, so only it gets discarded. */
  private sentCapability: string | null = null;
  private retryTimer = 0;
  private nextId = 1;
  private runs = new Map<number, PendingRun>();
  private namespaceWaiters = new Map<number, (vars: NamespaceVar[]) => void>();
  private artifactsWaiters = new Map<number, (artifacts: Artifacts | null) => void>();
  private tableWaiters = new Map<number, (window: TableWindow | null) => void>();
  private figureWaiters = new Map<number, (result: FigureResult | null) => void>();
  private restartWaiters = new Map<number, () => void>();
  private storageListener = (event: StorageEvent) => {
    if (event.key === CAPABILITY_KEY && event.newValue && this.awaitingPair) {
      // `knuth app --hosted` may open a second tab. Pairing there updates
      // origin storage; an already-installed PWA should recover too.
      this.pair(event.newValue);
    }
  };
  // A launch URL can land in a window that is already open, where the OS or
  // browser changes only the fragment and nothing reloads. The initial read
  // happened at construction, so catch the later ones here.
  private hashListener = () => this.pairWithFragment();

  constructor(
    private url: string = DEFAULT_KERNEL_URL,
    private onStatus?: (status: KernelStatus, resumed?: boolean) => void,
  ) {
    window.addEventListener('storage', this.storageListener);
    window.addEventListener('hashchange', this.hashListener);
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
    // A silent pairing retry must not flicker the toolbar back to
    // 'connecting…' over the pairing message the user is reading.
    if (!this.awaitingPair) this.onStatus?.('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.sentCapability = localStorage.getItem(CAPABILITY_KEY);
      ws.send(
        JSON.stringify({
          type: 'attach',
          protocol: PROTOCOL_VERSION,
          session: sessionId(),
          capability: this.sentCapability,
          pairing: this.pairingToken,
        }),
      );
    });
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
    if (this.awaitingPair) {
      // Keep the pairing message up, but keep looking: the capability may
      // arrive in this profile without a storage event reaching this window.
      this.scheduleConnect(PAIRING_RETRY_MS);
      return;
    }
    this.connectedReady = false;
    this.failPending('kernel connection lost');
    if (this.reattachAfterClose) {
      this.reattachAfterClose = false;
      this.connect();
      return;
    }
    this.onStatus?.('down');
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
        break;
      }
      case 'paired': {
        if (msg.protocol !== PROTOCOL_VERSION) {
          this.rejectIncompatible(msg.protocol);
          break;
        }
        if (
          typeof msg.capability !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(msg.capability)
        ) {
          this.rejectUnauthorized('unauthorized');
          break;
        }
        localStorage.setItem(CAPABILITY_KEY, msg.capability);
        this.pairingToken = null;
        break;
      }
      case 'incompatible': {
        this.rejectIncompatible(msg.protocol);
        break;
      }
      case 'unauthorized': {
        this.rejectUnauthorized('unauthorized');
        break;
      }
      case 'pairing_expired': {
        this.pairingToken = null;
        this.rejectUnauthorized('pairing_expired');
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
        // Authorized after all — a later drop is an ordinary drop again.
        this.awaitingPair = false;
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
      case 'protocol_error': {
        this.rejectRequest(msg);
        break;
      }
      case 'kernel_exit': {
        this.connectedReady = false;
        this.failPending(
          typeof msg.error === 'string' ? msg.error : 'Python engine exited unexpectedly',
        );
        this.onStatus?.('down');
        this.ws?.close(1011, 'kernel process exited');
        break;
      }
      case 'server_busy': {
        this.connectedReady = false;
        this.failPending(msg.error);
        this.onStatus?.('down');
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

  private rejectUnauthorized(status: 'unauthorized' | 'pairing_expired'): void {
    const alreadyShown = this.awaitingPair;
    this.awaitingPair = true;
    this.connectedReady = false;
    // Discard only the credential this socket actually presented: another
    // window may have paired us while this attach was in flight.
    if (localStorage.getItem(CAPABILITY_KEY) === this.sentCapability) {
      localStorage.removeItem(CAPABILITY_KEY);
    }
    this.failPending('kernel pairing required');
    // A retry that lands on the same wall keeps the first, more specific
    // explanation rather than rewriting it every fifteen seconds.
    if (!alreadyShown) this.onStatus?.(status);
    this.ws?.close(4401, 'pairing required');
  }

  pair(capability: string): void {
    const normalized = capability.trim();
    if (!normalized) return;
    localStorage.setItem(CAPABILITY_KEY, normalized);
    this.pairingToken = null;
    this.reconnectWithNewCredential();
  }

  /** Spend a `#pair=` token that arrived after this window was already up. */
  private pairWithFragment(): void {
    const token = consumePairingFragment();
    if (!token) return;
    this.pairingToken = token;
    this.reconnectWithNewCredential();
  }

  private reconnectWithNewCredential(): void {
    this.awaitingPair = false;
    if (this.ws && this.ws.readyState < WebSocket.CLOSING) {
      // Close first so the server sees the session as resumable rather than an
      // active duplicate tab, which would intentionally fork its namespace.
      this.reattachAfterClose = true;
      this.connectedReady = false;
      this.ws.close(1000, 're-pairing');
    } else {
      this.connect();
    }
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
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.restartWaiters.set(id, resolve);
      this.send({ type: 'restart', id });
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

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    window.removeEventListener('storage', this.storageListener);
    window.removeEventListener('hashchange', this.hashListener);
    this.ws?.close();
  }
}
