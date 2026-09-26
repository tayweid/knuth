// File System Access / File Handling API surfaces not yet in lib.dom
// (Chromium-only; feature-detected at every call site).

interface FilePickerType {
  description?: string;
  accept: Record<string, string[]>;
}

type PickerStartIn =
  | FileSystemHandle
  | 'desktop'
  | 'documents'
  | 'downloads'
  | 'music'
  | 'pictures'
  | 'videos';

interface OpenFilePickerOptions {
  types?: FilePickerType[];
  multiple?: boolean;
  id?: string;
  startIn?: PickerStartIn;
}

interface SaveFilePickerOptions {
  types?: FilePickerType[];
  suggestedName?: string;
  id?: string;
  startIn?: PickerStartIn;
}

interface DirectoryPickerOptions {
  mode?: 'read' | 'readwrite';
  id?: string;
  startIn?: PickerStartIn;
}

interface FileSystemHandle {
  /** Same file or directory on disk, even via a different handle. */
  isSameEntry?(other: FileSystemHandle): Promise<boolean>;
}

interface FileSystemFileHandle {
  /** Chromium: rename within the same directory. */
  move?(name: string): Promise<void>;
}

interface FileSystemHandle {
  queryPermission?(desc?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(desc?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
}

interface Window {
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  launchQueue?: {
    setConsumer(consumer: (params: { files: FileSystemHandle[] }) => void): void;
  };
}

// Knuth.app (APP.md): the shell registers a `knuth` message handler. The
// page posts requests carrying an id, and the shell answers each through
// `window.knuthShell.reply(id, result)`. Dialogs answer `{path}` (null when
// cancelled); file requests answer like the engine's files.py replies, so
// the same file manager hooks work against either.
interface KnuthShellMessage {
  type: 'open' | 'saveAs' | 'read' | 'write' | 'stat' | 'rename' | 'remove' | 'status' | 'error';
  id?: number;
  path?: string;
  text?: string;
  name?: string;
  state?: string;
  message?: string;
}

interface KnuthShellHandler {
  postMessage(message: KnuthShellMessage): void;
}

interface Window {
  webkit?: { messageHandlers?: { knuth?: KnuthShellHandler } };
  knuthShell?: { reply(id: number, result: unknown): void };
}
