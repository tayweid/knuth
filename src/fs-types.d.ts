// File System Access / File Handling API surfaces not yet in lib.dom
// (Chromium-only; feature-detected at every call site).

interface FilePickerType {
  description?: string;
  accept: Record<string, string[]>;
}

interface OpenFilePickerOptions {
  types?: FilePickerType[];
  multiple?: boolean;
}

interface SaveFilePickerOptions {
  types?: FilePickerType[];
  suggestedName?: string;
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
  showDirectoryPicker?(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>;
  launchQueue?: {
    setConsumer(consumer: (params: { files: FileSystemHandle[] }) => void): void;
  };
}
