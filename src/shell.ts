// The page's side of the Claerbout shell protocol (APP.md, "Electron, one
// shell for Claerbout"). A Claerbout app's shell exposes, through its
// preload:
//
//   window.claerbout.request(message) → Promise<reply>
//   window.claerbout.on(event, listener) → unsubscribe
//
// Every request is answered, notices (status, error, choose) with null.
// Dialogs answer {path} (null when cancelled); file requests answer like
// the engine's files.py replies, so one file manager serves both. Events
// are the shell telling the page something unasked: `setup` ({kind:
// 'progress' | 'failed', text}) on the first-launch screen, `openFile`
// ({path}) for a document opened into an existing window.
//
// Knuth's Swift shell predates this and speaks WebKit's message handler:
// the page posts to window.webkit.messageHandlers.knuth with an id, and the
// shell answers through window.knuthShell.reply(id, result). Until the
// Electron shell has replaced it, the page speaks both, preferring
// window.claerbout. A plain browser tab has neither: `shell` is null and
// the page keeps the File System Access flow.

export interface ShellMessage {
  type: 'open' | 'saveAs' | 'read' | 'write' | 'stat' | 'rename' | 'remove' | 'choose' | 'status' | 'error';
  path?: string;
  text?: string;
  name?: string;
  python?: string;
  state?: string;
  message?: string;
}

export type ShellEvent = 'setup' | 'openFile';

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

interface WebKitHandler {
  postMessage(message: ShellMessage & { id?: number }): void;
}

export interface ShellHost {
  claerbout?: ClaerboutBridge;
  webkit?: { messageHandlers?: { knuth?: WebKitHandler } };
  knuthShell?: { reply(id: number, result: unknown): void };
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
  if (bridge) {
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

  const handler = host.webkit?.messageHandlers?.knuth;
  if (!handler) return null;
  let nextId = 1;
  const waiters = new Map<number, (result: unknown) => void>();
  host.knuthShell = {
    reply: (id, result) => {
      const resolve = waiters.get(id);
      waiters.delete(id);
      resolve?.(result);
    },
  };
  const request = <T>(message: ShellMessage) => {
    const id = nextId++;
    return new Promise<T | null>((resolve) => {
      waiters.set(id, (result) => resolve((result ?? null) as T | null));
      handler.postMessage({ ...message, id });
    });
  };
  return {
    request,
    // The Swift shell answers only messages that carry an id, so a notice
    // goes without one rather than leaving a waiter behind.
    notify: (message) => handler.postMessage(message),
    pickPath: withPath(request),
  };
}

export const shell: Shell | null =
  typeof window === 'undefined' ? null : connectShell(window as unknown as ShellHost);
