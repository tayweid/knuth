// The page's side of the Claerbout shell protocol (APP.md, "Electron, one
// shell for Claerbout"). A Claerbout app's shell exposes, through its
// preload:
//
//   window.claerbout.request(message) → Promise<reply>
//   window.claerbout.on(event, listener) → unsubscribe
//
// Every request is answered, notices (status, error, choose, ready) with
// null. `ready` says the page is listening for a dropped document, for an
// app whose shell opens documents by drop (main.js, dropDocument); Knuth's
// pages never send it.
// Dialogs answer {path} (null when cancelled); file requests answer like
// the engine's files.py replies, so one file manager serves both. Events
// are the shell telling the page something unasked: `setup` ({kind:
// 'progress' | 'failed', text}) on the first-launch screen, and `update`
// ({state, text?, latest?, current?}) as the app checks its site for a
// newer build and installs one (`update` requests: a check, answered
// {state: 'current' | 'available' | 'development' | 'unsupported' |
// 'failed', …}; with action 'install', the install, followed by events
// 'downloading' … 'ready', or 'failed').
//
// `autosave` ({trigger}) is a notice: something happened in the page
// worth a commit on the project's autosave record (docs/AUTOSAVE.md),
// which the shell keeps — it has the filesystem and knows the window's
// document; the page only says when. Knuth sends it when a cell's run
// completes (`reportCellRun`). A shell without the record logs it as
// unknown and answers null, which is nothing to the page.
//
// A plain browser tab has no shell: `shell` is null and the page keeps the
// File System Access flow.

export interface ShellMessage {
  type: 'open' | 'saveAs' | 'read' | 'write' | 'stat' | 'rename' | 'remove' | 'choose' | 'status' | 'error' | 'ready' | 'update' | 'autosave';
  action?: 'install';
  path?: string;
  text?: string;
  name?: string;
  python?: string;
  state?: string;
  message?: string;
  /** What happened, for the autosave record's commit message: `cell run [4]`. */
  trigger?: string;
}

export type ShellEvent = 'setup' | 'update';

/** A step of the app updating itself, as the shell reports it. */
export interface UpdateStep {
  state: string;
  text?: string;
  percent?: number | null;
  latest?: { version?: string | null; build?: string; built?: string | null };
  current?: { version?: string | null; build?: string | null; built?: string | null };
}

export interface Shell {
  /** Ask the shell and wait for its answer; null when it has none. */
  request<T>(message: ShellMessage): Promise<T | null>;
  /** Tell the shell something without waiting (status, error, choose). */
  notify(message: ShellMessage): void;
  /** The native dialogs: an absolute path, or null if cancelled. */
  pickPath(message: ShellMessage): Promise<string | null>;
  /** The shell's unasked events; returns the unsubscribe. */
  on(event: ShellEvent, listener: (detail: unknown) => void): () => void;
}

export interface ClaerboutBridge {
  request(message: ShellMessage): Promise<unknown>;
  on(event: ShellEvent, listener: (detail: unknown) => void): () => void;
}

export interface ShellHost {
  claerbout?: ClaerboutBridge;
}

function withPath(request: Shell['request']): Shell['pickPath'] {
  return (message) =>
    request<{ path?: string | null }>(message).then((reply) =>
      typeof reply?.path === 'string' && reply.path ? reply.path : null,
    );
}

/** The shell this page runs in, or null in a plain browser tab. */
export function connectShell(host: ShellHost): Shell | null {
  const bridge = host.claerbout;
  if (!bridge) return null;
  const request = <T>(message: ShellMessage) =>
    bridge.request(message).then(
      (reply) => (reply ?? null) as T | null,
      () => null,
    );
  return {
    request,
    notify: (message) => void request(message),
    pickPath: withPath(request),
    on: (event, listener) => bridge.on(event, listener),
  };
}

/** Cells' runs completed (cleanly or not: either way their outputs are
 *  new) and their writes landed: the shell's autosave record gets
 *  `cell run [4]`, the cell's number in the document, or `cell run [1, 2,
 *  3]` for runs reported together. Nothing without a shell, or with no
 *  cells. */
export function reportCellRun(host: Shell | null, cells: readonly number[]): void {
  if (!host || cells.length === 0) return;
  host.notify({ type: 'autosave', trigger: `cell run [${cells.join(', ')}]` });
}

export const shell: Shell | null =
  typeof window === 'undefined' ? null : connectShell(window as unknown as ShellHost);
