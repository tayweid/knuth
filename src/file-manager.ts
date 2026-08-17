// Real files: open/save .py cell documents on disk. Plass's FileManager
// pattern, trimmed: File System Access handles with silent debounced
// autosave on Chromium; <input type=file> / download fallback elsewhere.

import { parseDocument, serializeDocument, type KnuthDocument } from './format/percent.ts';

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
}

const PY_TYPE: FilePickerType[] = [
  { description: 'Python cell documents', accept: { 'text/x-python': ['.py'] } },
];

const NEW_DOC = '# %%\n';
const ARTIFACT_MANIFEST = '.knuth-artifacts.json';
const MAX_FIGURE_NAME_BYTES = 128;
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

function isSafeFigureName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith('_') &&
    /^\p{ID_Start}\p{ID_Continue}*$/u.test(name) &&
    name === name.normalize('NFC') &&
    new TextEncoder().encode(name).byteLength <= MAX_FIGURE_NAME_BYTES &&
    !WINDOWS_RESERVED_NAMES.has(name.toUpperCase())
  );
}

function parseOwnedFigureNames(raw: string): Set<string> {
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== 'object') return new Set();
    const manifest = data as { version?: unknown; figures?: unknown };
    if (manifest.version !== 1 || !Array.isArray(manifest.figures)) return new Set();
    const names = new Set<string>();
    for (const path of manifest.figures) {
      if (typeof path !== 'string' || !path.startsWith('figs/') || !path.endsWith('.svg')) {
        return new Set();
      }
      const name = path.slice('figs/'.length, -'.svg'.length);
      if (!isSafeFigureName(name) || path !== `figs/${name}.svg`) return new Set();
      names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

export interface RecentEntry {
  name: string;
  time: number;
  handle: FileSystemFileHandle;
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
  name = 'untitled.py';
  dirty = false;
  /** Last session's file awaiting a permission re-grant (needs a user
   *  gesture) — the document on screen IS this file's latest state. */
  pendingHandle: FileSystemFileHandle | null = null;
  readonly supportsFS = typeof window.showOpenFilePicker === 'function';
  private saveTimer = 0;
  private stashTimer = 0;

  constructor(private hooks: FileHooks) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush();
    });
  }

  /** Call on every document change: marks dirty, schedules a disk autosave
   *  and a session stash (so reload restores the document alongside the
   *  resumed kernel session). */
  noteChange() {
    if (!this.dirty) {
      this.dirty = true;
      this.hooks.onState();
    }
    if (this.handle) {
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
      };
      this.hooks.setDoc(parseDocument(snap.text));
      this.name = snap.name;
      this.dirty = snap.dirty;
      if (snap.figures) this.hooks.setFigures?.(snap.figures);
    } catch (e) {
      console.warn('Session restore failed', e);
      return false;
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
    if (!this.handle || !this.dirty) return;
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
  }

  newDoc() {
    this.handle = null;
    this.pendingHandle = null;
    this.name = 'untitled.py';
    this.dirty = false;
    this.hooks.setDoc(parseDocument(NEW_DOC));
    this.hooks.onState();
    this.stash();
  }

  async open() {
    if (!this.supportsFS) {
      this.openViaInput();
      return;
    }
    try {
      const [handle] = await window.showOpenFilePicker!({ types: PY_TYPE });
      await this.loadHandle(handle);
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') console.warn(e);
    }
  }

  async loadHandle(handle: FileSystemFileHandle) {
    const file = await handle.getFile();
    this.hooks.setDoc(parseDocument(await file.text()));
    this.handle = handle;
    this.name = file.name;
    this.dirty = false;
    this.writeBlockedNotified = false;
    this.hooks.onState();
    this.hooks.message(`Opened ${file.name}`);
    void this.addRecent(handle, file.name);
    void idbSet('last', handle).catch(() => undefined);
    this.stash();
    this.hooks.onOpened?.();
  }

  // ---------- recents ----------

  async recents(): Promise<RecentEntry[]> {
    try {
      return (await idbGet<RecentEntry[]>('recents')) ?? [];
    } catch {
      return [];
    }
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

  /** Rename in place (Chromium handle.move); enforces the .py suffix. */
  async rename(newName: string): Promise<boolean> {
    newName = newName.trim();
    if (!newName) return false;
    if (!/\.py$/i.test(newName)) newName += '.py';
    if (newName === this.name) return true;
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
      const manifest = JSON.stringify(
        { version: 1, figures: names.map((name) => `figs/${name}.svg`) },
        null,
        2,
      ) + '\n';
      // Commit ownership last: it never claims a file that was not already
      // written successfully, and pre-manifest SVGs are never inferred.
      await this.writeFile(this.dir, ARTIFACT_MANIFEST, manifest);
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
    input.accept = '.py';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      this.hooks.setDoc(parseDocument(await file.text()));
      this.handle = null;
      this.name = file.name;
      this.dirty = false;
      this.hooks.onState();
    };
    input.click();
  }

  private download() {
    const blob = new Blob([serializeDocument(this.hooks.getDoc())], { type: 'text/x-python' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = this.name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
