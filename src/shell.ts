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
// 'progress' | 'failed', text}) on the first-launch screen.
//
// A plain browser tab has no shell: `shell` is null and the page keeps the
// File System Access flow.

export interface ShellMessage {
  type: 'open' | 'saveAs' | 'read' | 'write' | 'stat' | 'rename' | 'remove' | 'choose' | 'status' | 'error' | 'ready';
  path?: string;
  text?: string;
  name?: string;
  python?: string;
  state?: string;
  message?: string;
}

export type ShellEvent = 'setup';

export interface Shell {
  /** Ask the shell and wait for its answer; null when it has none. */
  request<T>(message: ShellMessage): Promise<T | null>;
  /** Tell the shell something without waiting (status, error, choose). */
  notify(message: ShellMessage): void;
  /** The native dialogs: an absolute path, or null if cancelled. */
  pickPath(message: ShellMessage): Promise<string | null>;
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
  };
}

export const shell: Shell | null =
  typeof window === 'undefined' ? null : connectShell(window as unknown as ShellHost);
