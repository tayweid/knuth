// Real files: open/save .py cell documents on disk. Two modes (APP.md):
//
// - By PATH: the document has an absolute path and the engine reads,
//   writes, stats and renames it over the socket. This is Knuth.app, and
//   any page opened with ?open=. No browser file handles, no permission
//   prompts, works in every browser.
// - By HANDLE: Plass's FileManager pattern, trimmed — File System Access
//   handles with silent debounced autosave on Chromium; <input type=file>
//   / download fallback elsewhere. The plain-browser-tab path.
//
// `path` being set is the mode switch; everything else follows from it.

import { parseDocument, serializeDocument, type KnuthDocument } from './format/percent.ts';
import type {
  DocumentResult,
  PersistedResult,
  RenamedResult,
  SavedResult,
  StatResult,
} from './kernel/kernel.ts';
import { ARTIFACT_MANIFEST, isSafeFigureName, manifestText, parseOwnedFigureNames } from './artifacts.ts';
import { findHeader, spliceHeader } from './header.ts';

export interface FileHooks {
  getDoc(): KnuthDocument;
  /** Replace the document on screen (open, new). */
  setDoc(doc: KnuthDocument): void;
  /** Name/dirty changed — update chrome. */
  onState(): void;
  message(text: string): void;
  /** A document was opened from disk (picker, recent, launch). */
  onOpened?(): void;
  /** Autosave needs a write permission it can only get from a gesture
   *  (typical after a Finder launch): offer the user a grant button. */
  onSaveBlocked?(): void;
  /** Displayed figures per cell, for the session stash / its restore. */
  getFigures?(): Array<string[] | null>;
  setFigures?(figures: Array<string[] | null>): void;
  /** .ipynb JSON → percent-format text, via the engine's one converter
   *  (null: no engine connection). */
  convert?(text: string): Promise<{ text?: string; error?: string; commented?: number } | null>;
  /** The open file changed on disk under a clean document (an outside
   *  editor, knuth run receipts): here is its fresh parse. */
  onDiskChange?(doc: KnuthDocument): void;
  /** Only the preamble changed (a header the engine grew): update it
   *  without rebuilding the cells, which may be running. */
  setPreamble?(lines: string[]): void;
  /** Documents by path, answered by the engine (null: no engine). */
  openPath?(path: string): Promise<DocumentResult | null>;
  savePath?(path: string, text: string): Promise<SavedResult | null>;
  statPath?(path: string): Promise<StatResult | null>;
  renamePath?(path: string, name: string): Promise<RenamedResult | null>;
  persist?(): Promise<PersistedResult | null>;
  /** Native dialogs from the shell: an absolute path, or null if cancelled.
   *  Present means the page runs inside Knuth.app. */
  pickPath?(): Promise<string | null>;
  pickSavePath?(name: string): Promise<string | null>;
  /** The document's path changed without a new document arriving (save
   *  as, rename): the session's environment is per document, so the
   *  caller restarts the kernel for the new path. */
  onPathChanged?(path: string | null): void;
}

/** The folder part of an absolute path, either separator. */
export function dirname(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut <= 0 ? path.slice(0, 1) : path.slice(0, cut);
}

export function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(cut + 1);
}

const RECENT_PATHS = 'knuth-recent-paths';
export interface RecentPath {
  name: string;
  path: string;
  time: number;
}

function readRecentPaths(): RecentPath[] {
  try {
    const raw = localStorage.getItem(RECENT_PATHS);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (e): e is RecentPath =>
        !!e && typeof e === 'object' &&
        typeof (e as RecentPath).name === 'string' &&
        typeof (e as RecentPath).path === 'string' &&
        typeof (e as RecentPath).time === 'number',
    );
  } catch {
    return [];
  }
}

// Any text file opens: .py as a cell document, .ipynb converted, and
// everything else in the plain source editor (the file_handlers list in
// manifest.webmanifest names the same set for OS launches). One picker
// type carries them all — separate filter entries would hide .py files
// exactly when someone is looking for either.
const TEXT_EXTENSIONS = [
  '.txt', '.text', '.md', '.markdown', '.qmd', '.rmd', '.log', '.json', '.jsonl',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.csv', '.tsv',
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.sh', '.bash', '.zsh', '.tex', '.sty', '.bib', '.typ', '.r', '.jl',
  '.sql', '.xml', '.svg', '.rs', '.go', '.c', '.h', '.cpp', '.hpp',
  '.java', '.rb', '.lua', '.php',
];
const PY_TYPE: FilePickerType[] = [
  {
    description: 'Python cell documents and text files',
    accept: {
      'text/x-python': ['.py', '.pyi'],
      'application/x-ipynb+json': ['.ipynb'],
      'text/plain': TEXT_EXTENSIONS,
    },
  },
];

const NEW_DOC = '# %%\n';

// The engine's inbound frame cap (limits.py MAX_INBOUND_MESSAGE_BYTES,
// minus envelope slack): an oversized frame closes the socket instead of
// answering, so the refusal has to happen here, politely.
const MAX_CONVERT_WIRE_BYTES = 1024 * 1024 - 1024;

/** Outputs dominate a notebook's bytes and the converter drops them
 *  anyway: send only what conversion reads, so real notebooks fit under
 *  the engine's frame cap. Anything unparseable passes through as-is —
 *  the engine's converter is the one voice for naming a bad notebook. */
function slimNotebook(raw: string): string {
  try {
    const data = JSON.parse(raw) as { nbformat?: unknown; cells?: unknown };
    if (!Array.isArray(data.cells)) return raw;
    return JSON.stringify({
      nbformat: data.nbformat,
      cells: data.cells.map((cell) => {
        const { cell_type, source } = (cell ?? {}) as Record<string, unknown>;
        return { cell_type, source };
      }),
    });
  } catch {
    return raw;
  }
}
/** The default document name. It is what the browser tab shows, so it says
 *  which app the tab is rather than that the file is nameless. */
export const DEFAULT_DOC_NAME = 'Knuth.py';
export interface RecentEntry {
  name: string;
  time: number;
  /** Handle mode. */
  handle?: FileSystemFileHandle;
  /** Path mode. */
  path?: string;
}

// Minimal IndexedDB kv store: file handles are structured-cloneable, so
// recents survive across sessions (permission is re-asked on open).
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('knuth-files', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export class FileManager {
  handle: FileSystemFileHandle | null = null;
  /** Project folder: where the contract (values.json, figs/) lands. */
  dir: FileSystemDirectoryHandle | null = null;
  /** Path mode: the document's absolute path, and the folder the session's
   *  kernel runs in (the path's folder; kept for a homeless new doc). */
  path: string | null = null;
  root: string | null = null;
  name = DEFAULT_DOC_NAME;
  dirty = false;
  /** Last session's file awaiting a permission re-grant (needs a user
   *  gesture) — the document on screen IS this file's latest state. */
  pendingHandle: FileSystemFileHandle | null = null;
  readonly supportsFS = typeof window.showOpenFilePicker === 'function';
  private saveTimer = 0;
  private stashTimer = 0;
  /** Bumped on every edit: a save is clean only if none arrived while it
   *  was in flight, whatever the engine did to the text meanwhile. */
  private changes = 0;
  /** lastModified of the disk version this document reflects (read or
   *  written by us) — the watcher's baseline for "someone else wrote". */
  private diskModified = 0;

  constructor(private hooks: FileHooks) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush();
      // Coming back from the outside editor is exactly when a disk
      // change is most likely — don't make the return wait for a tick.
      else void this.pollDisk();
    });
    window.setInterval(() => void this.pollDisk(), 1500);
  }

  /** External edits, hot-reloaded. The File System Access API has no
   *  stable change events, so the handle is polled: lastModified is a
   *  cheap metadata read, and our own writes advance diskModified in
   *  write() so a poll only ever fires for a writer that is not us. A
   *  dirty document never reloads — its autosave is about to overwrite
   *  disk anyway (last writer wins, the same rule two autosaving windows
   *  already live by). */
  private async pollDisk() {
    if (this.dirty) return;
    if (this.path) {
      await this.pollPath();
      return;
    }
    if (!this.handle) return;
    let file: File;
    try {
      file = await this.handle.getFile();
    } catch {
      return; // moved, deleted, or permission lapsed — surfaces on save
    }
    if (file.lastModified === this.diskModified) return;
    this.diskModified = file.lastModified;
    const text = await file.text();
    if (text === serializeDocument(this.hooks.getDoc())) return;
    this.hooks.onDiskChange?.(parseDocument(text));
    this.hooks.message(`${this.name} changed on disk — reloaded`);
    this.stash();
  }

  /** Path mode's change poll: a cheap stat by path, then a re-read only
   *  when the mtime moved past what we last read or wrote. */
  private async pollPath() {
    if (!this.path || !this.hooks.statPath) return;
    const stat = await this.hooks.statPath(this.path);
    if (!stat || stat.error || stat.modified == null) return; // gone, or no engine
    if (stat.modified === this.diskModified) return;
    const fresh = await this.hooks.openPath?.(this.path);
    if (!fresh || fresh.error || typeof fresh.text !== 'string') return;
    if (this.dirty) return; // typed meanwhile: the autosave wins
    this.diskModified = fresh.modified ?? stat.modified;
    if (fresh.text === serializeDocument(this.hooks.getDoc())) return;
    this.hooks.onDiskChange?.(parseDocument(fresh.text));
    this.hooks.message(`${this.name} changed on disk — reloaded`);
    this.stash();
  }

  /** Whether this page runs inside Knuth.app (native dialogs available). */
  get inShell(): boolean {
    return typeof this.hooks.pickPath === 'function';
  }

  /** Call on every document change: marks dirty, schedules a disk autosave
   *  and a session stash (so reload restores the document alongside the
   *  resumed kernel session). */
  noteChange() {
    this.changes += 1;
    if (!this.dirty) {
      this.dirty = true;
      this.hooks.onState();
    }
    if (this.handle || this.path) {
      clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => void this.flush(), 1200);
    }
    clearTimeout(this.stashTimer);
    this.stashTimer = window.setTimeout(() => this.stash(), 400);
  }

  /** Snapshot to sessionStorage: same lifetime as the kernel session —
   *  survives reloads of this tab, never shared with a new window.
   *  Displayed figures ride along under a size budget (SVGs are chunky;
   *  the document text always wins). */
  private stash() {
    const base = {
      name: this.name,
      dirty: this.dirty,
      text: serializeDocument(this.hooks.getDoc()),
      path: this.path,
      root: this.root,
      modified: this.diskModified,
    };
    let figures = this.hooks.getFigures?.();
    if (figures) {
      let budget = 3_000_000;
      figures = figures.map((svgs) => {
        if (!svgs) return null;
        const size = svgs.reduce((n, s) => n + s.length, 0);
        if (size > budget) return null;
        budget -= size;
        return svgs;
      });
    }
    try {
      sessionStorage.setItem('knuth-doc', JSON.stringify({ ...base, figures }));
    } catch {
      try {
        // Quota: drop the figures, never the document.
        sessionStorage.setItem('knuth-doc', JSON.stringify(base));
      } catch (e) {
        console.warn('Session stash failed', e);
      }
    }
  }

  /** Boot-time restore of the reloaded tab's document; reconnects the
   *  file/folder handles silently when the browser still grants them. */
  async restoreSession(): Promise<boolean> {
    const raw = sessionStorage.getItem('knuth-doc');
    if (!raw) return false;
    try {
      const snap = JSON.parse(raw) as {
        name: string;
        dirty: boolean;
        text: string;
        figures?: Array<string[] | null>;
        path?: string | null;
        root?: string | null;
        modified?: number;
      };
      // Name first: setDoc reads it to decide plain-file mode.
      this.name = snap.name;
      this.path = typeof snap.path === 'string' ? snap.path : null;
      this.root = typeof snap.root === 'string' ? snap.root : null;
      this.diskModified = typeof snap.modified === 'number' ? snap.modified : 0;
      this.hooks.setDoc(parseDocument(snap.text));
      this.dirty = snap.dirty;
      if (snap.figures) this.hooks.setFigures?.(snap.figures);
    } catch (e) {
      console.warn('Session restore failed', e);
      return false;
    }
    if (this.path) {
      // By path there is nothing to reconnect: the engine has the file.
      this.hooks.onState();
      return true;
    }
    try {
      const last = await idbGet<FileSystemFileHandle>('last');
      if (last && last.name === this.name) {
        const q = await last.queryPermission?.({ mode: 'readwrite' });
        if (q === 'granted') this.handle = last;
        else this.pendingHandle = last;
      }
      const lastDir = await idbGet<FileSystemDirectoryHandle>('lastDir');
      if (lastDir) {
        const q = await lastDir.queryPermission?.({ mode: 'readwrite' });
        if (q === 'granted') this.dir = lastDir;
      }
    } catch (e) {
      console.warn('Handle reconnect failed', e);
    }
    this.hooks.onState();
    return true;
  }

  /** Re-grant the pending file handle (needs a user gesture). */
  async reconnect() {
    const handle = this.pendingHandle;
    if (!handle) return;
    const r = await handle.requestPermission?.({ mode: 'readwrite' });
    if (r === 'granted') {
      this.handle = handle;
      this.pendingHandle = null;
      this.hooks.onState();
      this.hooks.message(`Autosave reconnected to ${handle.name}`);
    }
  }

  private writeBlockedNotified = false;

  private async flush() {
    if (!this.dirty) return;
    if (this.path) {
      await this.flushPath();
      return;
    }
    if (!this.handle) return;
    try {
      await this.write(this.handle);
      this.dirty = false;
      this.writeBlockedNotified = false;
      this.hooks.onState();
    } catch (e) {
      // Chrome only shows write-permission prompts during user gestures,
      // so a timer-driven autosave on a freshly launched file gets
      // NotAllowedError until the user grants once. Surface it (once).
      if ((e as DOMException)?.name === 'NotAllowedError') {
        if (!this.writeBlockedNotified) {
          this.writeBlockedNotified = true;
          this.hooks.onSaveBlocked?.();
        }
      } else {
        console.warn('Autosave failed', e);
      }
    }
  }

  private saveFailedNotified = false;

  private async flushPath() {
    if (!this.path || !this.hooks.savePath) return;
    const text = serializeDocument(this.hooks.getDoc());
    const before = this.changes;
    const saved = await this.hooks.savePath(this.path, text);
    if (!saved) return; // no engine yet: the next change retries
    if (saved.error) {
      if (!this.saveFailedNotified) {
        this.saveFailedNotified = true;
        this.hooks.message(`Could not save: ${saved.error}`);
      }
      return;
    }
    this.saveFailedNotified = false;
    if (typeof saved.modified === 'number') this.diskModified = saved.modified;
    // A new file gets its header from the engine: what is on disk is the
    // text plus that block, so the page adopts it rather than writing the
    // headerless version back.
    if (saved.header) this.spliceHeader(saved.header, saved.modified);
    // Only what was written is clean: a keystroke during the round trip
    // stays dirty and reschedules.
    if (this.changes === before) {
      this.dirty = false;
      this.hooks.onState();
    }
  }

  /** The engine rewrote the document's PEP 723 header on disk (a package
   *  installed for a cell, a header given to a new file): splice the new
   *  block into the text on screen, keeping any unsaved edit, and treat
   *  the write as our own so the change poll does not reload over it. */
  spliceHeader(lines: string[], modified?: number) {
    const doc = this.hooks.getDoc();
    const preamble = spliceHeader(doc.preamble, lines);
    if (typeof modified === 'number') this.diskModified = modified;
    if (preamble.join('\n') === doc.preamble.join('\n')) return;
    if (this.hooks.setPreamble) this.hooks.setPreamble(preamble);
    else this.hooks.onDiskChange?.({ ...doc, preamble });
    this.stash();
  }

  /** Whether the document declares its packages (has a PEP 723 block). */
  get hasHeader(): boolean {
    return findHeader(this.hooks.getDoc().preamble) !== null;
  }

  /** Open a document by absolute path through the engine (APP.md). The
   *  path's folder becomes the session root; the caller restarts the
   *  kernel there through the setDoc hook. */
  async openPath(path: string): Promise<boolean> {
    if (!this.hooks.openPath) return false;
    const reply = await this.hooks.openPath(path);
    if (!reply) {
      this.hooks.message('Opening a document needs the engine — is it running?');
      return false;
    }
    if (reply.error || typeof reply.text !== 'string' || typeof reply.path !== 'string') {
      this.hooks.message(`Could not open ${basename(path)}: ${reply.error ?? 'no document'}`);
      return false;
    }
    this.handle = null;
    this.pendingHandle = null;
    this.dir = null;
    this.root = dirname(reply.path);
    this.name = reply.name ?? basename(reply.path);
    if (reply.unsaved) {
      // A converted notebook: adopt the sibling .py path only if nothing is
      // there yet — autosave would otherwise write over someone's file.
      const existing = await this.hooks.statPath?.(reply.path);
      const free = !!existing && !existing.error && existing.modified == null;
      this.path = free ? reply.path : null;
      this.hooks.setDoc(parseDocument(reply.text));
      this.dirty = true;
      this.diskModified = 0;
      this.saveFailedNotified = false;
      this.hooks.onState();
      const note = reply.commented ? `, ${reply.commented} line(s) commented out` : '';
      this.hooks.message(
        free
          ? `Imported ${basename(path)}${note} — saving as ${this.name}`
          : `Imported ${basename(path)}${note} — ${this.name} exists, choose where to save`,
      );
      if (free) this.noteChange();
      this.stash();
      return true;
    }
    this.path = reply.path;
    this.hooks.setDoc(parseDocument(reply.text));
    this.diskModified = reply.modified ?? 0;
    this.dirty = false;
    this.saveFailedNotified = false;
    this.hooks.onState();
    this.hooks.message(`Opened ${this.name}`);
    this.addRecentPath(reply.path, this.name);
    this.stash();
    this.hooks.onOpened?.();
    return true;
  }

  /** Give a homeless document a path and write it there. */
  async saveAs(path: string): Promise<boolean> {
    if (!this.hooks.savePath) return false;
    const text = serializeDocument(this.hooks.getDoc());
    const saved = await this.hooks.savePath(path, text);
    if (!saved || saved.error) {
      this.hooks.message(`Could not save: ${saved?.error ?? 'the engine is not running'}`);
      return false;
    }
    this.handle = null;
    this.pendingHandle = null;
    this.dir = null;
    this.path = saved.path ?? path;
    this.root = dirname(this.path);
    this.name = basename(this.path);
    this.diskModified = saved.modified ?? 0;
    this.dirty = false;
    if (saved.header) this.spliceHeader(saved.header, saved.modified);
    this.hooks.onState();
    this.hooks.message(`Saved ${this.name}`);
    this.addRecentPath(this.path, this.name);
    this.stash();
    this.hooks.onOpened?.();
    this.hooks.onPathChanged?.(this.path);
    return true;
  }

  /** The kernel writes values.json and figs/ into its own folder. */
  async persist(): Promise<void> {
    if (!this.hooks.persist) return;
    const result = await this.hooks.persist();
    if (result?.error) this.hooks.message(`Could not write the project folder: ${result.error}`);
  }

  private addRecentPath(path: string, name: string) {
    const kept: RecentPath[] = [{ name, path, time: Date.now() }];
    for (const entry of readRecentPaths()) {
      if (entry.path === path) continue;
      kept.push(entry);
      if (kept.length >= 8) break;
    }
    try {
      localStorage.setItem(RECENT_PATHS, JSON.stringify(kept));
    } catch (e) {
      console.warn('Could not persist recents', e);
    }
  }

  /** Grant write access to the current file (call from a user gesture). */
  async grantWrite() {
    if (!this.handle) return;
    const r = await this.handle.requestPermission?.({ mode: 'readwrite' });
    if (r === 'granted') {
      this.writeBlockedNotified = false;
      await this.flush();
      this.hooks.message(`Saving to ${this.name}`);
    }
  }

  private async write(handle: FileSystemFileHandle) {
    const writable = await handle.createWritable();
    await writable.write(serializeDocument(this.hooks.getDoc()));
    await writable.close();
    // Our own write is not an external change: move the baseline past it.
    this.diskModified = (await handle.getFile()).lastModified;
  }

  newDoc() {
    this.handle = null;
    this.pendingHandle = null;
    this.path = null; // root stays: the session keeps its folder
    this.name = DEFAULT_DOC_NAME;
    this.dirty = false;
    this.hooks.setDoc(parseDocument(NEW_DOC));
    this.hooks.onState();
    this.stash();
  }

  async open() {
    if (this.hooks.pickPath) {
      const path = await this.hooks.pickPath();
      if (path) await this.openPath(path);
      return;
    }
    if (!this.supportsFS) {
      this.openViaInput();
      return;
    }
    try {
      const [handle] = await window.showOpenFilePicker!({ types: PY_TYPE });
      if (/\.ipynb$/i.test(handle.name)) {
        await this.importNotebook(await handle.getFile());
      } else {
        await this.loadHandle(handle);
      }
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') console.warn(e);
    }
  }

  /** Open a notebook: the engine converts, and the document arrives as an
   *  unsaved .py named after it — saving writes the .py wherever the save
   *  flow lands it; the .ipynb itself is never touched (one-way import). */
  async importNotebook(file: File) {
    if (!this.hooks.convert) return;
    const slimmed = slimNotebook(await file.text());
    if (new TextEncoder().encode(JSON.stringify(slimmed)).length > MAX_CONVERT_WIRE_BYTES) {
      this.hooks.message(`${file.name} is too large to import here — run: knuth import`);
      return;
    }
    const result = await this.hooks.convert(slimmed);
    if (!result) {
      this.hooks.message('Importing a notebook needs the engine — is it running?');
      return;
    }
    if (typeof result.text !== 'string') {
      this.hooks.message(`Could not import ${file.name}: ${result.error ?? 'no conversion result'}`);
      return;
    }
    this.name = file.name.replace(/\.ipynb$/i, '.py');
    this.hooks.setDoc(parseDocument(result.text));
    this.handle = null;
    this.path = null;
    this.pendingHandle = null;
    this.dirty = true;
    this.writeBlockedNotified = false;
    this.hooks.onState();
    const note = result.commented ? `, ${result.commented} line(s) commented out` : '';
    this.hooks.message(`Imported ${file.name}${note} — saving writes ${this.name}`);
    this.stash();
  }

  /** Folders the user has already granted, newest first. */
  private async knownFolders(): Promise<FileSystemDirectoryHandle[]> {
    const stored = (await idbGet<FileSystemDirectoryHandle[]>('folders')) ?? [];
    const last = await idbGet<FileSystemDirectoryHandle>('lastDir');
    return last ? [last, ...stored.filter((d) => d !== last)] : stored;
  }

  private async rememberFolder(dir: FileSystemDirectoryHandle) {
    const kept = [dir];
    for (const known of await this.knownFolders()) {
      if (kept.length >= 12) break;
      if (!(await known.isSameEntry?.(dir))) kept.push(known);
    }
    await idbSet('folders', kept).catch(() => undefined);
  }

  /** The already-granted folder this file lives in, if we have one.
   *
   *  A launched file arrives as a bare handle: the browser deliberately
   *  withholds its path, and a page cannot obtain a directory without a user
   *  gesture. But it CAN test whether a file is inside a directory it was
   *  already given — so the second file you open from a folder, and every one
   *  after, needs no asking.
   */
  private async folderContaining(
    handle: FileSystemFileHandle,
  ): Promise<FileSystemDirectoryHandle | null> {
    for (const dir of await this.knownFolders()) {
      try {
        // Silent only: prompting needs a gesture we do not have here.
        const granted = (await dir.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
        if (granted !== 'granted') continue;
        const candidate = await dir.getFileHandle(handle.name).catch(() => null);
        if (candidate && (await candidate.isSameEntry?.(handle))) return dir;
      } catch {
        continue;
      }
    }
    return null;
  }

  async loadHandle(handle: FileSystemFileHandle) {
    const file = await handle.getFile();
    this.path = null;
    this.name = file.name;
    this.hooks.setDoc(parseDocument(await file.text()));
    this.handle = handle;
    this.diskModified = file.lastModified;
    this.dirty = false;
    this.writeBlockedNotified = false;
    this.hooks.onState();
    this.hooks.message(`Opened ${file.name}`);
    void this.addRecent(handle, file.name);
    void idbSet('last', handle).catch(() => undefined);
    // A file opened from a folder we already hold belongs to that folder.
    // Asking again would be asking a question we know the answer to.
    const home = await this.folderContaining(handle);
    if (home) {
      this.dir = home;
      void idbSet('lastDir', home).catch(() => undefined);
    }
    this.stash();
    this.hooks.onOpened?.();
  }

  // ---------- recents ----------

  async recents(): Promise<RecentEntry[]> {
    const byPath: RecentEntry[] = readRecentPaths();
    let byHandle: RecentEntry[] = [];
    try {
      byHandle = (await idbGet<RecentEntry[]>('recents')) ?? [];
    } catch {
      byHandle = [];
    }
    // The shell has no use for handles it cannot open; a tab can use both.
    const all = this.inShell ? byPath : [...byPath, ...byHandle];
    return all.sort((a, b) => b.time - a.time).slice(0, 8);
  }

  private async addRecent(handle: FileSystemFileHandle, name: string) {
    try {
      const list = (await idbGet<RecentEntry[]>('recents')) ?? [];
      const kept: RecentEntry[] = [{ name, time: Date.now(), handle }];
      for (const entry of list) {
        if (entry.name === name) continue;
        kept.push(entry);
        if (kept.length >= 8) break;
      }
      await idbSet('recents', kept);
    } catch (e) {
      console.warn('Could not persist recents', e);
    }
  }

  /** Reopen a recent file; stored handles need a permission re-grant
   *  (browsers downgrade them across sessions — the click is our gesture). */
  async openRecent(entry: RecentEntry) {
    if (entry.path) {
      await this.openPath(entry.path);
      return;
    }
    if (!entry.handle) return;
    try {
      const q = (await entry.handle.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
      if (q !== 'granted') {
        const r = await entry.handle.requestPermission?.({ mode: 'readwrite' });
        if (r !== 'granted') {
          this.hooks.message(`No permission to reopen ${entry.name}`);
          return;
        }
      }
      await this.loadHandle(entry.handle);
    } catch (e) {
      console.warn('Recent open failed', e);
      this.hooks.message(`Could not reopen ${entry.name} — it may have moved`);
    }
  }

  async save() {
    if (this.path) {
      await this.flushPath();
      return;
    }
    if (this.hooks.pickSavePath) {
      const path = await this.hooks.pickSavePath(this.name);
      if (path) await this.saveAs(path);
      return;
    }
    if (!this.supportsFS) {
      this.download();
      return;
    }
    if (!this.handle) {
      // Saving a homeless document IS choosing its project folder: the
      // one directory grant covers the file, values.json, and figs/.
      await this.attachFolder('save');
      return;
    }
    await this.write(this.handle);
    this.dirty = false;
    this.hooks.onState();
  }

  /** Rename in place (Chromium handle.move); a name typed without an
   *  extension keeps the file's current one. */
  async rename(newName: string): Promise<boolean> {
    newName = newName.trim();
    if (!newName) return false;
    if (!/\.[^./]+$/.test(newName)) {
      newName += this.name.match(/\.[^./]+$/)?.[0] ?? '.py';
    }
    if (newName === this.name) return true;
    if (this.path) {
      const renamed = await this.hooks.renamePath?.(this.path, newName);
      if (!renamed || renamed.error || typeof renamed.path !== 'string') {
        this.hooks.message(`Could not rename: ${renamed?.error ?? 'the engine is not running'}`);
        return false;
      }
      this.path = renamed.path;
      this.name = renamed.name ?? newName;
      if (typeof renamed.modified === 'number') this.diskModified = renamed.modified;
      this.addRecentPath(this.path, this.name);
      this.hooks.onState();
      this.stash();
      this.hooks.onPathChanged?.(this.path);
      return true;
    }
    if (this.handle) {
      if (typeof this.handle.move !== 'function') {
        this.hooks.message('Renaming needs a newer Chrome (FileSystemHandle.move)');
        return false;
      }
      try {
        await this.handle.move(newName);
      } catch (e) {
        console.warn('Rename failed', e);
        this.hooks.message('Could not rename the file');
        return false;
      }
    }
    this.name = newName;
    this.hooks.onState();
    return true;
  }

  // ---------- project folder: the contract ----------

  /** The one-grant entry point: a directory handle covers everything in
   *  it, so attaching the project folder also gives the document a home —
   *  the newest .py inside is opened (intent 'open', untouched doc), or
   *  the current document moves in — with no second permission prompt. */
  async attachFolder(intent: 'open' | 'save' = 'open'): Promise<boolean> {
    if (typeof window.showDirectoryPicker !== 'function') {
      this.hooks.message('Project folders need the File System Access API (Chrome/Edge)');
      return false;
    }
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await window.showDirectoryPicker!({
        mode: 'readwrite',
        id: 'knuth-project',
        // Open the picker AT the current file's own folder (a launched or
        // opened file's handle is a valid startIn hint) — the usual case
        // is one click to confirm.
        startIn: this.handle ?? undefined,
      });
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') console.warn(e);
      return false;
    }
    this.dir = dir;
    void idbSet('lastDir', dir).catch(() => undefined);
    void this.rememberFolder(dir);
    try {
      if (!this.handle) {
        // Never load over unsaved work, and a SAVE never opens someone
        // else's file: the current document moves in instead.
        const newest = intent === 'save' || this.dirty ? null : await this.newestPy(dir);
        if (newest) {
          await this.loadHandle(newest);
        } else {
          this.handle = await dir.getFileHandle(this.name, { create: true });
          await this.write(this.handle);
          this.dirty = false;
          this.hooks.message(`${this.name} lives in ${dir.name} now`);
          void this.addRecent(this.handle, this.name);
        }
        this.hooks.onState();
        return true;
      }
    } catch (e) {
      console.warn('Folder adoption failed', e);
    }
    this.hooks.onState();
    this.hooks.message(`Project folder: ${dir.name} — values.json and figs/ stay fresh`);
    return true;
  }

  private async newestPy(
    dir: FileSystemDirectoryHandle,
  ): Promise<FileSystemFileHandle | null> {
    let best: { handle: FileSystemFileHandle; time: number } | null = null;
    for await (const entry of dir.values()) {
      if (entry.kind !== 'file' || !/\.py$/i.test(entry.name)) continue;
      const handle = entry as FileSystemFileHandle;
      const file = await handle.getFile();
      if (!best || file.lastModified > best.time) {
        best = { handle, time: file.lastModified };
      }
    }
    return best?.handle ?? null;
  }

  /** Materialize the kernel's artifacts into the project folder:
   *  values.json regenerated wholesale, figures into figs/<name>.svg. */
  async writeArtifacts(values: Record<string, unknown>, figures: Record<string, string>) {
    if (!this.dir) return;
    try {
      const names = Object.keys(figures).sort();
      const currentNames = new Set(names);
      const collisionKeys = new Set<string>();
      for (const name of names) {
        const collisionKey = name.toLocaleLowerCase('en-US');
        if (!isSafeFigureName(name) || collisionKeys.has(collisionKey)) {
          throw new Error(`unsafe or colliding figure artifact name: ${JSON.stringify(name)}`);
        }
        collisionKeys.add(collisionKey);
      }
      const previous = await this.readOwnedFigureNames(this.dir);

      await this.writeFile(this.dir, 'values.json', JSON.stringify(values, null, 2) + '\n');
      if (names.length > 0 || previous.size > 0) {
        const figs = await this.dir.getDirectoryHandle('figs', { create: true });
        for (const name of names) {
          await this.writeFile(figs, `${name}.svg`, figures[name]);
        }
        for (const name of previous) {
          if (currentNames.has(name)) continue;
          try {
            await figs.removeEntry(`${name}.svg`);
          } catch (error) {
            if ((error as DOMException)?.name !== 'NotFoundError') throw error;
          }
        }
      }
      // Commit ownership last: it never claims a file that was not already
      // written successfully, and pre-manifest SVGs are never inferred.
      await this.writeFile(this.dir, ARTIFACT_MANIFEST, manifestText(names));
    } catch (e) {
      console.warn('Contract write failed', e);
      this.hooks.message('Could not write to the project folder');
    }
  }

  private async readOwnedFigureNames(dir: FileSystemDirectoryHandle): Promise<Set<string>> {
    try {
      const handle = await dir.getFileHandle(ARTIFACT_MANIFEST);
      return parseOwnedFigureNames(await (await handle.getFile()).text());
    } catch {
      // Migration and malformed-manifest behavior is intentionally safe:
      // without a trustworthy record, Knuth owns nothing and deletes nothing.
      return new Set();
    }
  }

  private async writeFile(dir: FileSystemDirectoryHandle, name: string, text: string) {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  // ---------- non-Chromium fallbacks ----------

  private openViaInput() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ['.py', '.pyi', '.ipynb', ...TEXT_EXTENSIONS].join(',');
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (/\.ipynb$/i.test(file.name)) {
        await this.importNotebook(file);
        return;
      }
      this.name = file.name;
      this.hooks.setDoc(parseDocument(await file.text()));
      this.handle = null;
      this.path = null;
      this.dirty = false;
      this.hooks.onState();
    };
    input.click();
  }

  private download() {
    const type = /\.py$/i.test(this.name) ? 'text/x-python' : 'text/plain';
    const blob = new Blob([serializeDocument(this.hooks.getDoc())], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = this.name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
