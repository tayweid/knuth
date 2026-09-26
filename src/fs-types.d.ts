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

// Knuth.app (APP.md): the shell registers a `knuth` message handler and
// answers dialog requests by calling back into the page.
interface KnuthShellHandler {
  postMessage(message: { type: 'open' } | { type: 'saveAs'; name: string }): void;
}

interface Window {
  webkit?: { messageHandlers?: { knuth?: KnuthShellHandler } };
  /** Installed by the page; the shell calls `chose` with the absolute path
   *  picked in its NSOpenPanel/NSSavePanel, or null when cancelled. */
  knuthShell?: { chose(path: string | null): void };
}
