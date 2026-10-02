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
// completes (`reportCellRun`), `cell run [4] (error)` when it raised. A
// shell without the record logs it as unknown and answers null, which is
// nothing to the page.
//
// The record's history view (the shell's README, "The history view";
// docs/mockups/history.md) is the shell's own window: `history` ({action:
// 'open'}) opens it for this window's project, answered {opened: true},
// and a window with no record says why itself; an older shell answers
// null. A rewind there asks every window on the project first, by the
// event `save` ({id, reason: 'rewind'}), to write its document, and waits
// 3 seconds for `saved` ({id, ok, error?}; ok: false refuses the rewind);
// then, by `reload` ({id, paths, reason, to, app?}: every file written or
// removed, absolute; `app` when another app rewound), each re-reads its
// document if its path is among them. `reload` is not answered
// (`answerRewinds`).
//
// A plain browser tab has no shell: `shell` is null and the page keeps the
// File System Access flow.

export interface ShellMessage {
  type:
    | 'open' | 'saveAs' | 'read' | 'write' | 'stat' | 'rename' | 'remove' | 'choose' | 'status' | 'error'
    | 'ready' | 'update' | 'autosave' | 'history' | 'saved';
  action?: 'install' | 'open';
  path?: string;
  text?: string;
  name?: string;
  python?: string;
  state?: string;
  message?: string;
  /** What happened, for the autosave record's commit message: `cell run [4]`. */
  trigger?: string;
  /** `saved`: the `save` event it answers, and whether the disk holds the
   *  document (with why not). */
  id?: string;
  ok?: boolean;
  error?: string;
}

export type ShellEvent = 'setup' | 'update' | 'save' | 'reload';

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
 *  `cell run [4]`, the cell's number as its receipt counts it (the code
 *  cells only; DocumentView.cellNumber), or `cell run [1, 2, 3]` for runs
 *  reported together, with ` (error)` when any of them raised, which the
 *  history view draws as a red ring. Nothing without a shell, or with no
 *  cells. */
export function reportCellRun(host: Shell | null, cells: readonly number[], raised = false): void {
  if (!host || cells.length === 0) return;
  host.notify({ type: 'autosave', trigger: `cell run [${cells.join(', ')}]${raised ? ' (error)' : ''}` });
}

/** What the page does for a rewind in the history view. */
export interface RewindPage {
  /** The open document's absolute path; null when it has none. */
  path(): string | null;
  /** Write the document now, through ⌘S's write, and hold the autosave
   *  until the rewind's `reload` (or `release`): null once the disk holds
   *  it (at once when nothing is unsaved), else why it could not. */
  save(): Promise<string | null>;
  /** The rewind is over and did not touch this document: autosave again. */
  release(): void;
  /** Re-read the document from disk and replace it in place; `rewound`
   *  says by whom and to what (`rewindNote`). */
  reload(rewound: string): Promise<void>;
}

/** The same file, as far as a page can tell without the disk: macOS keeps
 *  /tmp, /var and /etc as links into /private, and git names a project by
 *  where the link points, so a rewind's `/private/tmp/x.py` is the
 *  `/tmp/x.py` a launch gave the page; names in one Unicode form. */
export function samePath(a: string, b: string): boolean {
  const plain = (file: string) => file.normalize('NFC').replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, '');
  return plain(a) === plain(b);
}

/** A rewind's reload, in words: `Rewound to 1a2b3c4`, or `Rewound by
 *  Plass to 1a2b3c4` when another app made it. */
export function rewindNote(to: unknown, app?: unknown): string {
  const by = typeof app === 'string' && app && app !== 'knuth' ? ` by ${app[0].toUpperCase()}${app.slice(1)}` : '';
  const target = typeof to === 'string' && /^[0-9a-f]{7,64}$/i.test(to) ? ` to ${to.slice(0, 7)}` : '';
  return `Rewound${by}${target}`;
}

/** The page's side of a rewind: every `save` answered with `saved` (ok,
 *  or ok: false and why), every `reload` naming this document's path
 *  re-reads it; any other `reload` only ends the hold the save began.
 *  Returns the unsubscribe. */
export function answerRewinds(host: Shell, page: RewindPage): () => void {
  const offSave = host.on('save', (detail) => {
    const id = (detail as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') return;
    void page
      .save()
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
      .then((error) => host.notify(error === null ? { type: 'saved', id, ok: true } : { type: 'saved', id, ok: false, error }));
  });
  const offReload = host.on('reload', (detail) => {
    const { paths, to, app } = (detail ?? {}) as { paths?: unknown; to?: unknown; app?: unknown };
    const mine = page.path();
    const named = !!mine && Array.isArray(paths) && paths.some((file) => typeof file === 'string' && samePath(file, mine));
    if (named) void page.reload(rewindNote(to, app));
    else page.release();
  });
  return () => {
    offSave();
    offReload();
  };
}

/** The `history` request's answer as a sentence for the toast, or null
 *  when the view opened. Today's shell opens a window even where there is
 *  no record, and that window says why; a shell that answers with the
 *  reason instead (its words: `unsaved`, `refused` with the folder rule,
 *  `off`, `no-git`) has it said here, and an older shell, with no view,
 *  answers null. */
export function historyNote(answer: { opened?: unknown; reason?: unknown; detail?: unknown } | null): string | null {
  if (answer?.opened === true) return null;
  const detail = typeof answer?.detail === 'string' && answer.detail ? answer.detail : null;
  switch (answer?.reason) {
    case 'unsaved':
      return 'No history yet: save the document in a folder of its own, and the record begins';
    case 'refused':
      return `No history here: ${detail ?? 'its folder is not one the record keeps'}`;
    case 'off':
      return 'No history: the autosave record is off';
    case 'no-git':
      return 'No history: the record is kept with git, and this Mac has none';
    default:
      return answer ? 'No history view opened' : 'This Knuth.app has no history view: a newer shell brings it';
  }
}

export const shell: Shell | null =
  typeof window === 'undefined' ? null : connectShell(window as unknown as ShellHost);
