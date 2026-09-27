// The wire protocol between the app and the engine (KERNEL.md): the data
// shapes requests answer with, the versioned set of events the server may
// send, and the validation that treats every inbound event as untrusted
// until parsed. Pure functions, no socket state — SidecarKernel
// (kernel.ts) owns the connection.

export const PROTOCOL_VERSION = 2;

export type StreamWhich = 'stdout' | 'stderr';

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

export interface ConvertResult {
  /** Percent-format document text, when conversion succeeded. */
  text?: string;
  /** What made the input not a notebook, when it failed. */
  error?: string;
  /** Lines the converter had to comment out (magics, raw cells). */
  commented?: number;
}

/** A document the engine read by path (APP.md). An .ipynb arrives
 *  converted and `unsaved`, under a sibling .py path it has not written. */
export interface DocumentResult {
  path?: string;
  name?: string;
  text?: string;
  /** Milliseconds since the epoch; null for a document not on disk. */
  modified?: number | null;
  unsaved?: boolean;
  commented?: number;
  error?: string;
}

export interface SavedResult {
  path?: string;
  modified?: number;
  error?: string;
  /** A save that created a file with no PEP 723 header: the engine
   *  prepended one and these are its lines, to splice into the page. */
  header?: string[];
}

/** Which Python this session's kernel runs on (docs/ENVIRONMENT.md): the
 *  document's own environment, or the system Python with a reason. Sent
 *  once per kernel start; `syncing` beforehand when uv has work to do. */
export interface EnvironmentEvent {
  document: string | null;
  state: 'syncing' | 'ready' | 'fallback';
  python: string;
  managed: boolean;
  reason?: string;
  /** While syncing: the step uv just reported ("Downloading scipy (33.1MiB)"). */
  detail?: string;
}

/** A cell imported a module the environment lacked; the engine is
 *  installing it. Not a stream, so it never lands in receipts. */
export interface DependencyEvent {
  id: number;
  state: 'installing' | 'installed' | 'failed';
  module: string;
  distribution: string;
  version?: string;
  error?: string;
  /** While installing: the step uv just reported. */
  detail?: string;
}

/** The engine rewrote the document's header on disk after an install. */
export interface HeaderEvent {
  id: number;
  /** null: the document is unsaved, and the header is the page's. */
  path: string | null;
  lines: string[];
  /** null when nothing on disk changed that the page must adopt. */
  modified: number | null;
}

export interface StatResult {
  path?: string;
  /** null: the file is gone. */
  modified?: number | null;
  error?: string;
}

export interface RenamedResult {
  path?: string;
  name?: string;
  modified?: number;
  error?: string;
}

/** The answer to an install request: done, and whether the session must
 *  restart to reach the document's environment (it had none before). */
export interface InstalledResult {
  ok: boolean;
  restart?: boolean;
  error?: string;
  /** Not on this Mac: adding it needs a download, which the person okays. */
  download?: boolean;
}

/** What fits at the cursor (knuth.complete): items replace from `start`. */
export interface CompletionItem {
  label: string;
  /** Jedi's kind: module, class, function, instance, keyword, param, … */
  type: string;
}

export interface CompletionsResult {
  start: number;
  items: CompletionItem[];
}

/** The kernel wrote the folder contract into its cwd. */
export interface PersistedResult {
  root?: string;
  values?: number;
  figures?: string[];
  error?: string;
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

export type ServerEvent =
  | { type: 'attached'; protocol: number; session: string; resumed: boolean; root?: string | null }
  | { type: 'incompatible'; protocol: number }
  | { type: 'ready'; resumed?: boolean; id?: number }
  | { type: 'stream'; id: number; which: StreamWhich; text: string }
  | { type: 'figures'; id: number; svgs: string[]; named: string[] }
  | { type: 'done'; id: number; result: string | null }
  | { type: 'error'; id: number; traceback: string }
  | { type: 'namespace'; id: number; vars: NamespaceVar[] }
  | { type: 'artifacts'; id: number; values: Record<string, unknown>; figures: Record<string, string> }
  | ({ type: 'table'; id: number } & TableWindow)
  | ({ type: 'figure'; id: number } & FigureResult)
  | ({ type: 'converted'; id: number } & ConvertResult)
  | ({ type: 'document'; id: number } & DocumentResult)
  | ({ type: 'saved'; id: number } & SavedResult)
  | ({ type: 'stat'; id: number } & StatResult)
  | ({ type: 'renamed'; id: number } & RenamedResult)
  | ({ type: 'persisted'; id: number } & PersistedResult)
  | ({ type: 'installed'; id: number } & InstalledResult)
  | ({ type: 'completions'; id: number } & CompletionsResult)
  | ({ type: 'environment' } & EnvironmentEvent)
  | ({ type: 'dependency' } & DependencyEvent)
  | ({ type: 'header' } & HeaderEvent)
  | { type: 'protocol_error'; error: string; request?: string; id?: number }
  | { type: 'kernel_exit'; error: string; returncode?: number; id?: number }
  | { type: 'server_busy'; error: string }
  | { type: 'kernel_start_failed'; error: string };

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

export function parseServerEvent(value: unknown): ServerEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  const event = value;
  switch (event.type) {
    case 'attached':
      return typeof event.protocol === 'number' && typeof event.session === 'string' &&
        typeof event.resumed === 'boolean' &&
        (event.root === undefined || event.root === null || typeof event.root === 'string')
        ? event as ServerEvent : null;
    case 'incompatible':
      return typeof event.protocol === 'number' ? event as ServerEvent : null;
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
    case 'converted':
      return isRequestId(event.id) &&
        (typeof event.text === 'string' || typeof event.error === 'string') &&
        optionalString(event.text) && optionalString(event.error) &&
        (event.commented === undefined || isRequestId(event.commented))
        ? event as ServerEvent : null;
    case 'document':
      return isRequestId(event.id) &&
        (typeof event.error === 'string' || (
          typeof event.path === 'string' && typeof event.name === 'string' &&
          typeof event.text === 'string' &&
          (event.modified === null || isRequestId(event.modified))
        )) &&
        optionalString(event.error) &&
        (event.unsaved === undefined || typeof event.unsaved === 'boolean') &&
        (event.commented === undefined || isRequestId(event.commented))
        ? event as ServerEvent : null;
    case 'saved':
    case 'renamed':
      return isRequestId(event.id) &&
        (typeof event.error === 'string' || (
          typeof event.path === 'string' && isRequestId(event.modified) &&
          (event.type === 'saved' || typeof event.name === 'string')
        )) && optionalString(event.error) &&
        (event.type === 'renamed' || optionalStringArray(event.header))
        ? event as ServerEvent : null;
    case 'completions':
      return isRequestId(event.id) && isRequestId(event.start) && Array.isArray(event.items) &&
        event.items.every((item) => isRecord(item) && typeof item.label === 'string' && typeof item.type === 'string')
        ? event as ServerEvent : null;
    case 'installed':
      return isRequestId(event.id) && typeof event.ok === 'boolean' &&
        (event.restart === undefined || typeof event.restart === 'boolean') &&
        (event.download === undefined || typeof event.download === 'boolean') &&
        optionalString(event.error) ? event as ServerEvent : null;
    case 'environment':
      return (event.document === null || typeof event.document === 'string') &&
        (event.state === 'syncing' || event.state === 'ready' || event.state === 'fallback') &&
        typeof event.python === 'string' && typeof event.managed === 'boolean' &&
        optionalString(event.reason) && optionalString(event.detail) ? event as ServerEvent : null;
    case 'dependency':
      return isRequestId(event.id) &&
        (event.state === 'installing' || event.state === 'installed' || event.state === 'failed') &&
        typeof event.module === 'string' && typeof event.distribution === 'string' &&
        optionalString(event.version) && optionalString(event.error) && optionalString(event.detail)
        ? event as ServerEvent : null;
    case 'header':
      return isRequestId(event.id) &&
        (event.path === null || typeof event.path === 'string') &&
        isStringArray(event.lines) &&
        (event.modified === null || isRequestId(event.modified)) ? event as ServerEvent : null;
    case 'stat':
      return isRequestId(event.id) &&
        (typeof event.error === 'string' || (
          typeof event.path === 'string' &&
          (event.modified === null || isRequestId(event.modified))
        )) && optionalString(event.error) ? event as ServerEvent : null;
    case 'persisted':
      return isRequestId(event.id) &&
        (typeof event.error === 'string' || (
          typeof event.root === 'string' && isRequestId(event.values) &&
          isStringArray(event.figures)
        )) && optionalString(event.error) ? event as ServerEvent : null;
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
    case 'kernel_start_failed':
      return typeof event.error === 'string' ? event as ServerEvent : null;
    default:
      return null;
  }
}
