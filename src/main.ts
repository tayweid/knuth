// Boot: toolbar + document view + file manager + kernel, then the
// launch-queue consumer LAST — Chrome delivers queued launch files
// synchronously inside setConsumer, so everything it touches must
// already be live (hard-won Plass lesson).

import './styles.css';
import { SidecarKernel } from './kernel/kernel.ts';
import { DocumentView } from './document-view.ts';
import { FileManager } from './file-manager.ts';
import { SessionPanel } from './panel.ts';

const toolbar = document.getElementById('toolbar')!;
toolbar.innerHTML = `
  <div class="tb-pod doc-pod"><span class="name" id="file-name">untitled.py</span></div>
  <div class="tb-pod tb-group">
    <button class="tb-btn" id="open" title="Open (Cmd-O)">Open</button>
    <button class="tb-btn" id="save" title="Save (Cmd-S)">Save</button>
    <button class="tb-btn" id="folder" title="Attach the project folder: values.json and figs/ are kept fresh there for Typst/Plass">Folder…</button>
  </div>
  <div class="tb-pod tb-group">
    <button class="tb-btn" id="run-stale" title="Run stale program cells in order">Run stale</button>
    <button class="tb-btn" id="run-all" title="Run all program cells from the top">Run all</button>
    <button class="tb-btn" id="stop" title="Interrupt the running cell">Stop</button>
    <button class="tb-btn" id="restart" title="Fresh session (kernel process replaced)">Restart</button>
  </div>
  <span class="spacer"></span>
  <div class="tb-pod tb-group">
    <button class="tb-btn" id="toggle-panel" title="Show/hide the session panes">Session</button>
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

const docView = new DocumentView(
  $('sheet'),
  kernel,
  () => fileManager?.noteChange(),
  syncArtifacts,
  () => void panel.refresh(),
);

fileManager = new FileManager({
  getDoc: () => docView.doc,
  setDoc: (doc) => docView.setDoc(doc),
  onState: () => {
    $('file-name').innerHTML = '';
    $('file-name').append(fileManager.name, fileManager.dirty ? ' ' : '');
    if (fileManager.dirty) {
      const dot = document.createElement('span');
      dot.className = 'dirty';
      dot.textContent = '●';
      $('file-name').append(dot);
    }
    // Just the file name: the installed app's window prepends its own
    // app name, so anything more reads twice.
    document.title = fileManager.name;
  },
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
    }
  },
  { capture: true },
);

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
