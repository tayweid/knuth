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

interface Window {
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
  launchQueue?: {
    setConsumer(consumer: (params: { files: FileSystemHandle[] }) => void): void;
  };
}
