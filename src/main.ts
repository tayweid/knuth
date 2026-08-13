// Boot: toolbar + document view + file manager + kernel, then the
// launch-queue consumer LAST — Chrome delivers queued launch files
// synchronously inside setConsumer, so everything it touches must
// already be live (hard-won Plass lesson).

import './styles.css';
import { SidecarKernel } from './kernel/kernel.ts';
import { DocumentView } from './document-view.ts';
import { FileManager } from './file-manager.ts';

const toolbar = document.getElementById('toolbar')!;
toolbar.innerHTML = `
  <span class="name" id="file-name">untitled.py</span>
  <button id="open" title="Open (Cmd-O)">Open</button>
  <button id="save" title="Save (Cmd-S)">Save</button>
  <span class="spacer"></span>
  <button id="run-stale">Run stale</button>
  <button id="run-all">Run all</button>
  <button id="stop" title="Interrupt the running cell">Stop</button>
  <button id="restart" title="Fresh session (kernel process replaced)">Restart</button>
  <span id="kernel-status">connecting…</span>
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
const docView = new DocumentView($('doc'), kernel, () => fileManager?.noteChange());

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
    document.title = `${fileManager.name} - Knuth`;
  },
  message: toast,
});

fileManager.newDoc();

$('open').addEventListener('click', () => void fileManager.open());
$('save').addEventListener('click', () => void fileManager.save());
$('run-all').addEventListener('click', () => void docView.runAllProgram());
$('run-stale').addEventListener('click', () => void docView.runStale());
$('stop').addEventListener('click', () => kernel.interrupt());
$('restart').addEventListener('click', () => {
  void kernel.restart().then(() => {
    docView.markAllStale();
    toast('Fresh session');
  });
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
