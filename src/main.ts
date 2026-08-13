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
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  scratch:
    '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3.4 2.8"/><line x1="9" y1="12" x2="15" y2="12"/>',
  text: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  play: '<polygon points="7 4.5 19 12 7 19.5"/>',
  playall: '<polygon points="3.5 5 11 12 3.5 19"/><polygon points="13 5 20.5 12 13 19"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  restart: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/>',
};

function icon(name: string): string {
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

// Plass's hover flyout: the trigger's group lays its labeled icons OVER
// the trigger — pure :hover, no gap for the cursor to cross.
function flyout(
  parent: HTMLElement,
  glyph: string,
  title: string,
  items: Array<{ glyph: string; label: string; title: string; run: () => void }>,
) {
  const wrap = document.createElement('span');
  wrap.className = 'tb-flyout-wrap';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'tb-btn';
  trigger.title = title;
  trigger.innerHTML = glyph;
  trigger.addEventListener('mousedown', (e) => e.preventDefault());
  wrap.append(trigger);
  const fly = document.createElement('span');
  fly.className = 'tb-flyout';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tb-btn';
    b.title = it.title;
    b.innerHTML = `${it.glyph}<span class="lbl">${it.label}</span>`;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', it.run);
    fly.append(b);
  }
  wrap.append(fly);
  parent.append(wrap);
}

function labeled(id: string, glyph: string, label: string, title: string): string {
  return `<button class="tb-btn" id="${id}" title="${title}">${glyph}<span class="lbl">${label}</span></button>`;
}

const toolbar = document.getElementById('toolbar')!;
toolbar.innerHTML = `
  <div class="tb-pod doc-pod" id="doc-pod"><span class="name" id="file-name" title="Click to rename">untitled.py</span></div>
  <div class="tb-pod tb-group" id="cells-pod">
    ${labeled('add-code', icon('code'), 'Code', 'Program cell below the current one')}
    ${labeled('add-scratch', icon('scratch'), 'Scratch', 'Scratch cell — explores the session, never persists')}
    ${labeled('add-text', icon('text'), 'Text', 'Markdown text cell')}
  </div>
  <div class="tb-pod tb-group">
    ${labeled('run-stale', icon('play'), 'Stale', 'Run stale program cells in order')}
    ${labeled('run-all', icon('playall'), 'All', 'Run all program cells from the top')}
    ${labeled('stop', icon('stop'), 'Stop', 'Interrupt the running cell')}
    ${labeled('restart', icon('restart'), 'Restart', 'Fresh session (kernel process replaced)')}
  </div>
  <div class="tb-pod tb-group">
    ${labeled('toggle-panel', icon('panel'), 'Session', 'Show/hide the session panes')}
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
  setDoc: (doc) => {
    docView.setDoc(doc);
    // A different document deserves a fresh session — otherwise the
    // previous document's variables haunt the explorer and values.json.
    if (kernel.isReady) {
      void kernel.restart().then(() => void panel.refresh());
    }
  },
  onState: repaintName,
  message: toast,
});

fileManager.newDoc();

// The file lifecycle lives in the name slug, one trigger flying out to
// three; the cells pod does the same for insertion.
flyout($('doc-pod'), icon('open'), 'File — open, save, project folder', [
  { glyph: icon('open'), label: 'Open', title: 'Open… (⌘O)', run: () => void fileManager.open() },
  { glyph: icon('save'), label: 'Save', title: 'Save (⌘S)', run: () => void fileManager.save() },
  {
    glyph: icon('project'),
    label: 'Folder',
    title: 'Attach the project folder: values.json and figs/ stay fresh there for Typst/Plass',
    run: () => void fileManager.attachFolder().then((ok) => ok && syncArtifacts()),
  },
]);

$('add-code').addEventListener('click', () => docView.insertRelative('program'));
$('add-scratch').addEventListener('click', () => docView.insertRelative('scratch'));
$('add-text').addEventListener('click', () => docView.insertRelative('text'));
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
