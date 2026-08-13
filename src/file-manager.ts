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
}

const PY_TYPE: FilePickerType[] = [
  { description: 'Python cell documents', accept: { 'text/x-python': ['.py'] } },
];

const NEW_DOC = '# %%\n';

export class FileManager {
  handle: FileSystemFileHandle | null = null;
  /** Project folder: where the contract (values.json, figs/) lands. */
  dir: FileSystemDirectoryHandle | null = null;
  name = 'untitled.py';
  dirty = false;
  readonly supportsFS = typeof window.showOpenFilePicker === 'function';
  private saveTimer = 0;

  constructor(private hooks: FileHooks) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.flush();
    });
  }

  /** Call on every document change: marks dirty, schedules a disk autosave. */
  noteChange() {
    if (!this.dirty) {
      this.dirty = true;
      this.hooks.onState();
    }
    if (this.handle) {
      clearTimeout(this.saveTimer);
      this.saveTimer = window.setTimeout(() => void this.flush(), 1200);
    }
  }

  private async flush() {
    if (!this.handle || !this.dirty) return;
    try {
      await this.write(this.handle);
      this.dirty = false;
      this.hooks.onState();
    } catch (e) {
      console.warn('Autosave failed', e);
    }
  }

  private async write(handle: FileSystemFileHandle) {
    const writable = await handle.createWritable();
    await writable.write(serializeDocument(this.hooks.getDoc()));
    await writable.close();
  }

  newDoc() {
    this.handle = null;
    this.name = 'untitled.py';
    this.dirty = false;
    this.hooks.setDoc(parseDocument(NEW_DOC));
    this.hooks.onState();
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
    this.hooks.onState();
    this.hooks.message(`Opened ${file.name}`);
  }

  async save() {
    if (!this.supportsFS) {
      this.download();
      return;
    }
    if (!this.handle) {
      await this.saveAs();
      return;
    }
    await this.write(this.handle);
    this.dirty = false;
    this.hooks.onState();
  }

  async saveAs() {
    if (!this.supportsFS) {
      this.download();
      return;
    }
    try {
      const handle = await window.showSaveFilePicker!({
        types: PY_TYPE,
        suggestedName: this.name,
      });
      this.handle = handle;
      this.name = handle.name;
      await this.write(handle);
      this.dirty = false;
      this.hooks.onState();
      this.hooks.message(`Saved ${handle.name}`);
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') console.warn(e);
    }
  }

  // ---------- project folder: the contract ----------

  async attachFolder(): Promise<boolean> {
    if (typeof window.showDirectoryPicker !== 'function') {
      this.hooks.message('Project folders need the File System Access API (Chrome/Edge)');
      return false;
    }
    try {
      this.dir = await window.showDirectoryPicker!({ mode: 'readwrite' });
      this.hooks.onState();
      this.hooks.message(`Project folder: ${this.dir.name} — values.json and figs/ stay fresh`);
      return true;
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') console.warn(e);
      return false;
    }
  }

  /** Materialize the kernel's artifacts into the project folder:
   *  values.json regenerated wholesale, figures into figs/<name>.svg. */
  async writeArtifacts(values: Record<string, unknown>, figures: Record<string, string>) {
    if (!this.dir) return;
    try {
      await this.writeFile(this.dir, 'values.json', JSON.stringify(values, null, 2) + '\n');
      const names = Object.keys(figures);
      if (names.length > 0) {
        const figs = await this.dir.getDirectoryHandle('figs', { create: true });
        for (const name of names) {
          await this.writeFile(figs, `${name}.svg`, figures[name]);
        }
      }
    } catch (e) {
      console.warn('Contract write failed', e);
      this.hooks.message('Could not write to the project folder');
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
