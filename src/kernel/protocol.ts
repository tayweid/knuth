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
  | { type: 'attached'; protocol: number; session: string; resumed: boolean }
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
        typeof event.resumed === 'boolean' ? event as ServerEvent : null;
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
