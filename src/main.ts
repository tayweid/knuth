// Boot: toolbar + document view + file manager + kernel, then the
// launch-queue consumer LAST — Chrome delivers queued launch files
// synchronously inside setConsumer, so everything it touches must
// already be live (hard-won Plass lesson).

import './styles.css';
import { SidecarKernel } from './kernel/kernel.ts';
import { DocumentView } from './document-view.ts';
import { FileManager } from './file-manager.ts';
import { SessionPanel } from './panel.ts';

// Feather-style inline icons, Plass's system (stroke = currentColor);
// file icons are Plass's own paths so the suite reads as one hand.
const ICONS: Record<string, string> = {
  open: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  project:
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><circle cx="12" cy="14" r="2.4"/><line x1="12" y1="9.5" x2="12" y2="11.6"/>',
  play: '<polygon points="7 4.5 19 12 7 19.5"/>',
  playall: '<polygon points="3.5 5 11 12 3.5 19"/><polygon points="13 5 20.5 12 13 19"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  restart: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/>',
};

function icon(name: string): string {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

const toolbar = document.getElementById('toolbar')!;
toolbar.innerHTML = `
  <div class="tb-pod doc-pod"><span class="name" id="file-name" title="Click to rename">untitled.py</span></div>
  <div class="tb-pod tb-group">
    <button class="tb-btn" id="open" title="Open (Cmd-O)">${icon('open')}</button>
    <button class="tb-btn" id="save" title="Save (Cmd-S)">${icon('save')}</button>
    <button class="tb-btn" id="folder" title="Attach the project folder: values.json and figs/ stay fresh there for Typst/Plass">${icon('project')}</button>
  </div>
  <div class="tb-pod tb-group">
    <button class="tb-btn" id="run-stale" title="Run stale program cells in order">${icon('play')}</button>
    <button class="tb-btn" id="run-all" title="Run all program cells from the top">${icon('playall')}</button>
    <button class="tb-btn" id="stop" title="Interrupt the running cell">${icon('stop')}</button>
    <button class="tb-btn" id="restart" title="Fresh session (kernel process replaced)">${icon('restart')}</button>
  </div>
  <div class="tb-pod tb-group">
    <button class="tb-btn" id="toggle-panel" title="Show/hide the session panes">${icon('panel')}</button>
    <span id="kernel-status">connecting…</span>
  </div>
`;

const $ = (id: string) => document.getElementById(id)!;
const toastEl = $('toast');
let toastTimer = 0;

function toast(text: string) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 2500);
}

const status = $('kernel-status');
let hadSession = false;
const kernel = new SidecarKernel(undefined, (state) => {
  if (state === 'ready') {
    status.textContent = 'kernel';
    status.className = 'ok';
    if (hadSession) {
      // Fresh process behind us (serve restarted, machine slept, …).
      docView.markAllStale();
      toast('Kernel session reset');
    }
    hadSession = true;
    void panel.refresh();
  } else if (state === 'down') {
    status.textContent = 'no kernel — install: knuth agent install';
    status.title = 'Retrying every 2s. One-time setup: knuth agent install';
    status.className = 'bad';
  } else {
    status.textContent = 'connecting…';
    status.className = '';
  }
});

let fileManager: FileManager;

// After program cells run, mirror the session into the project folder
// (values.json + figs/). Debounced so a run-all writes once at the end.
let artifactsTimer = 0;
function syncArtifacts() {
  if (!fileManager?.dir) return;
  clearTimeout(artifactsTimer);
  artifactsTimer = window.setTimeout(async () => {
    const artifacts = await kernel.artifacts();
    if (artifacts) await fileManager.writeArtifacts(artifacts.values, artifacts.figures);
  }, 300);
}

const panel = new SessionPanel($('panel'), kernel);
if (localStorage.getItem('knuth-panel') === '0') $('panel').hidden = true;

// Deleted cells get one immediate Cmd-Z lifeline, wherever focus is.
let pendingRestore: (() => void) | null = null;
let restoreTimer = 0;

const docView = new DocumentView(
  $('sheet'),
  kernel,
  () => fileManager?.noteChange(),
  syncArtifacts,
  () => void panel.refresh(),
  (restore) => {
    pendingRestore = restore;
    clearTimeout(restoreTimer);
    restoreTimer = window.setTimeout(() => (pendingRestore = null), 15000);
    toast('Cell deleted — ⌘Z restores it');
  },
);

function repaintName() {
  const label = $('file-name');
  label.textContent = '';
  label.append(fileManager.name, fileManager.dirty ? ' ' : '');
  if (fileManager.dirty) {
    const dot = document.createElement('span');
    dot.className = 'dirty';
    dot.textContent = '●';
    label.append(dot);
  }
  // Just the file name: the installed app's window prepends its own
  // app name, so anything more reads twice.
  document.title = fileManager.name;
}

fileManager = new FileManager({
  getDoc: () => docView.doc,
  setDoc: (doc) => docView.setDoc(doc),
  onState: repaintName,
  message: toast,
});

fileManager.newDoc();

$('open').addEventListener('click', () => void fileManager.open());
$('save').addEventListener('click', () => void fileManager.save());
$('folder').addEventListener('click', () => {
  void fileManager.attachFolder().then((attached) => {
    if (attached) {
      $('folder').textContent = `⌂ ${fileManager.dir!.name}`;
      syncArtifacts();
    }
  });
});
$('run-all').addEventListener('click', () => void docView.runAllProgram());
$('run-stale').addEventListener('click', () => void docView.runStale());
$('stop').addEventListener('click', () => kernel.interrupt());
$('restart').addEventListener('click', () => {
  void kernel.restart().then(() => {
    docView.markAllStale();
    void panel.refresh();
    toast('Fresh session');
  });
});
$('toggle-panel').addEventListener('click', () => {
  const el = $('panel');
  el.hidden = !el.hidden;
  localStorage.setItem('knuth-panel', el.hidden ? '0' : '1');
  if (!el.hidden) void panel.refresh();
});

window.addEventListener(
  'keydown',
  (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const key = e.key.toLowerCase();
    if (key === 's') {
      e.preventDefault();
      void fileManager.save();
    } else if (key === 'o') {
      e.preventDefault();
      void fileManager.open();
    } else if (key === 'z' && !e.shiftKey && pendingRestore) {
      // The undo the user means: bring the deleted cell back.
      e.preventDefault();
      e.stopPropagation();
      pendingRestore();
      pendingRestore = null;
    }
  },
  { capture: true },
);

// Click the document slug to rename the file in place.
$('file-name').addEventListener('click', () => {
  const label = $('file-name');
  if (label.querySelector('input')) return;
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = fileManager.name;
  label.textContent = '';
  label.append(input);
  input.focus();
  input.setSelectionRange(0, input.value.replace(/\.py$/i, '').length);
  let done = false;
  const finish = async (commit: boolean) => {
    if (done) return;
    done = true;
    if (commit) await fileManager.rename(input.value);
    repaintName(); // rebuilds the label whether renamed or cancelled
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void finish(true);
    else if (e.key === 'Escape') void finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => void finish(true));
});

// OS file-handler launches (installed PWA, Finder double-click) arrive
// here. Registered at end of boot, after every object it touches exists.
window.launchQueue?.setConsumer((params) => {
  const file = params.files[0];
  if (file && file.kind === 'file') {
    void fileManager.loadHandle(file as FileSystemFileHandle).catch((e) => {
      console.warn('Launched file failed to open', e);
      toast('Could not open the launched file — try again');
    });
  }
});
