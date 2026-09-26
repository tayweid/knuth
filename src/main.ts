// Boot: toolbar + document view + file manager + kernel, then the
// launch-queue consumer LAST — Chrome delivers queued launch files
// synchronously inside setConsumer, so everything it touches must
// already be live (hard-won Plass lesson).

import './frame-guard.ts';
import './styles.css';
import { SidecarKernel, type Kernel } from './kernel/kernel.ts';
import { LazyKernel } from './kernel/lazy-kernel.ts';
import { DocumentView, plainLanguageFor } from './document-view.ts';
import { delimiterFor } from './format/csv.ts';
import { DEFAULT_DOC_NAME, FileManager, dirname } from './file-manager.ts';
import { SessionPanel } from './panel.ts';
import { icon } from './icons.ts';
import { Onboarding } from './onboarding.ts';

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
  <div class="tb-pod doc-pod" id="doc-pod"><span class="name" id="file-name" title="Click to rename">${DEFAULT_DOC_NAME}</span></div>
  <div class="tb-pod tb-group" id="cells-pod">
    ${labeled('add-code', icon('code'), 'Code', 'Program cell below the current one')}
    ${labeled('add-scratch', icon('scratch'), 'Scratch', 'Scratch cell — explores the session, never persists')}
    ${labeled('add-text', icon('text'), 'Text', 'Markdown text cell')}
  </div>
  <div class="tb-pod tb-group" id="run-pod">
    ${labeled('run-stale', icon('play'), 'Stale', 'Run stale program cells in order')}
    ${labeled('run-all', icon('playall'), 'All', 'Run all program cells from the top')}
    ${labeled('stop', icon('stop'), 'Stop', 'Interrupt the running cell')}
    ${labeled('restart', icon('restart'), 'Restart', 'Fresh session (kernel process replaced)')}
  </div>
  <div class="tb-pod tb-group">
    ${labeled('toggle-panel', icon('panel'), 'Session', 'Show/hide the session panes')}
    <button type="button" id="install-app" hidden>Install</button>
    <span id="kernel-status">connecting…</span>
  </div>
`;

const $ = (id: string) => document.getElementById(id)!;
const toastEl = $('toast');
let toastTimer = 0;

function toast(text: string, action?: { label: string; run: () => void }) {
  toastEl.textContent = text;
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      toastEl.hidden = true;
      action.run();
    });
    toastEl.append(' ', btn);
  }
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), action ? 8000 : 2500);
}

const status = $('kernel-status');
const onboarding = new Onboarding(
  $('onboarding'),
  $('install-app') as HTMLButtonElement,
);
// The install click is what gives Knuth its own icon and a tab-less window.
// It is optional, so it lives in the toolbar — but a toolbar button nobody
// notices is the same as no offer at all. Surface it once, when the app is
// working and the browser says it can be installed.
const INSTALL_OFFERED = 'knuth-install-offered';
window.addEventListener('beforeinstallprompt', () => {
  if (localStorage.getItem(INSTALL_OFFERED)) return;
  localStorage.setItem(INSTALL_OFFERED, '1');
  window.setTimeout(() => {
    toast('Install Knuth for its own icon and window', {
      label: 'Install',
      run: () => ($('install-app') as HTMLButtonElement).click(),
    });
  }, 1200);
});

// Knuth.app (APP.md): the shell opens this page with ?open=<absolute path>,
// and its dialogs come through a message handler it registers. Both are
// feature-detected — a plain browser tab has neither and keeps the
// File System Access flow.
const openParam = new URLSearchParams(window.location.search).get('open');
const shell = window.webkit?.messageHandlers?.knuth ?? null;
let shellChoice: ((path: string | null) => void) | null = null;
window.knuthShell = {
  chose: (path) => {
    const resolve = shellChoice;
    shellChoice = null;
    resolve?.(typeof path === 'string' && path ? path : null);
  },
};
function askShell(message: Parameters<KnuthShellHandler['postMessage']>[0]) {
  return new Promise<string | null>((resolve) => {
    shellChoice?.(null); // one dialog at a time
    shellChoice = resolve;
    shell!.postMessage(message);
  });
}

// The kernel must start in the document's folder, and it attaches before
// the document opens: take the root from the URL, else from the session
// stash a reload is about to restore.
function stashedRoot(): string | null {
  try {
    const raw = sessionStorage.getItem('knuth-doc');
    const root = raw ? (JSON.parse(raw) as { root?: unknown }).root : null;
    return typeof root === 'string' ? root : null;
  } catch {
    return null;
  }
}
const initialRoot = openParam ? dirname(openParam) : stashedRoot();

// Served from loopback, an engine is behind this page and owns the session.
// Served from the web, there is no engine and never will be, so the preview
// runs Python in the tab instead (SAME_ORIGIN.md, "Pyodide in the
// preview"). The Pyodide backend is imported only in that case: the local
// app should not carry a runtime it will never load. `?python=browser`
// forces the in-tab backend anywhere, for testing the preview locally.
const servedLocally = ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
const pythonInBrowser =
  !servedLocally || new URLSearchParams(window.location.search).get('python') === 'browser';

type OnState = (state: Parameters<typeof onboarding.setState>[0], resumed?: boolean) => void;
function makeKernel(onState: OnState): Kernel {
  if (!pythonInBrowser) return new SidecarKernel(undefined, onState, initialRoot);
  const pending = import('./kernel/pyodide-kernel.ts').then(
    ({ PyodideKernel }) => new PyodideKernel(onState),
  );
  return new LazyKernel(pending, onState);
}

let hadSession = false;
let kernelState: Parameters<typeof onboarding.setState>[0] = 'connecting';
const kernel = makeKernel((state, resumed) => {
  kernelState = state;
  onboarding.setState(state);
  if (state === 'ready') {
    status.textContent = 'kernel';
    status.title = 'Connected to the local Python engine';
    status.className = 'ok';
    if (resumed && !hadSession) {
      // Reloaded tab reattached to its living session.
      toast('Session resumed');
    } else if (!resumed && hadSession) {
      // Genuinely fresh process behind us (restart, grace expired, …).
      docView.markAllStale();
      toast('Kernel session reset');
    }
    hadSession = true;
    void panel.refresh();
  } else if (state === 'down') {
    status.textContent = 'Python engine unavailable';
    status.title = 'Run: knuth app';
    status.className = 'bad';
  } else if (state === 'incompatible') {
    status.textContent = 'kernel/app versions do not match';
    status.title = 'Update and restart the Knuth agent, then reload the app';
    status.className = 'bad';
  } else if (state === 'busy') {
    status.textContent = 'too many sessions open';
    status.title = 'Close another Knuth window, or restart the engine';
    status.className = 'bad';
  } else if (state === 'kernel_failed') {
    status.textContent = 'Python could not start';
    status.title = 'The engine is running; starting Python for this window failed';
    status.className = 'bad';
  } else {
    status.textContent = 'connecting…';
    status.className = '';
  }
});

status.tabIndex = 0;
status.setAttribute('role', 'button');
function activateKernelStatus() {
  if (kernelState !== 'ready') onboarding.show();
}
status.addEventListener('click', activateKernelStatus);
status.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    activateKernelStatus();
  }
});

let fileManager: FileManager;

// After program cells run, mirror the session into the project folder
// (values.json + figs/). Debounced so a run-all writes once at the end.
// With no folder attached, the offer resurfaces here (throttled) — this
// is the moment the folder actually matters.
let artifactsTimer = 0;
let folderOfferAt = 0;
function syncArtifacts() {
  if (fileManager?.path || (fileManager?.root && fileManager.inShell)) {
    // By path, the kernel writes the contract into its own folder.
    clearTimeout(artifactsTimer);
    artifactsTimer = window.setTimeout(() => void fileManager.persist(), 300);
    return;
  }
  if (!fileManager?.dir) {
    if (Date.now() - folderOfferAt > 300_000) {
      folderOfferAt = Date.now();
      toast('values.json and figs/ have nowhere to go yet', {
        label: 'Attach folder',
        run: attachProjectFolder,
      });
    }
    return;
  }
  clearTimeout(artifactsTimer);
  artifactsTimer = window.setTimeout(async () => {
    const artifacts = await kernel.artifacts();
    if (artifacts) await fileManager.writeArtifacts(artifacts.values, artifacts.figures);
  }, 300);
}

function attachProjectFolder() {
  void fileManager.attachFolder().then((ok) => {
    if (ok) {
      syncArtifacts();
      docView.hydrateAll();
    }
  });
}

const panel = new SessionPanel($('panel'), kernel);
if (localStorage.getItem('knuth-panel') === '0') $('panel').hidden = true;

// Structural changes the editors' own history cannot undo (deleted cell,
// plain file converted to cells) get one immediate Cmd-Z lifeline,
// wherever focus is.
let pendingRestore: (() => void) | null = null;
let restoreTimer = 0;

// Resolve a figs/<name>.svg receipt against the project folder: by path
// through the engine, else through the attached directory handle.
async function loadFigureFromDir(path: string): Promise<string | null> {
  if (fileManager?.root) {
    const reply = await kernel.openPath(`${fileManager.root}/${path}`);
    return reply && !reply.error && typeof reply.text === 'string' ? reply.text : null;
  }
  const dir = fileManager?.dir;
  if (!dir) return null;
  try {
    const [folder, file] = path.split('/');
    const figsDir = await dir.getDirectoryHandle(folder);
    const handle = await figsDir.getFileHandle(file);
    return await (await handle.getFile()).text();
  } catch {
    return null;
  }
}

const docView = new DocumentView(
  $('sheet'),
  kernel,
  () => fileManager?.noteChange(),
  syncArtifacts,
  () => void panel.refresh(),
  (restore, message) => {
    pendingRestore = restore;
    clearTimeout(restoreTimer);
    restoreTimer = window.setTimeout(() => (pendingRestore = null), 15000);
    toast(message);
  },
  loadFigureFromDir,
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

// During boot restore, setDoc must NOT restart the kernel — the whole
// point is rejoining the resumed session with its document.
let restoring = true;

fileManager = new FileManager({
  getDoc: () => docView.doc,
  setDoc: (doc) => {
    // A non-.py file is a plain text file: pin it to the source editor
    // (the cell workbench is for Python cell documents).
    const name = fileManager?.name ?? DEFAULT_DOC_NAME;
    docView.setPlain(!/\.py$/i.test(name), plainLanguageFor(name));
    // A .csv/.tsv opens as a grid of cells, with the source editor a
    // toggle away.
    docView.setGrid(delimiterFor(name));
    docView.setDoc(doc);
    // A different document deserves a fresh session — otherwise the
    // previous document's variables haunt the explorer and values.json.
    // By path, the session also moves to the document's folder.
    if (!restoring && kernel.isReady) {
      void kernel.restart(fileManager?.root ?? undefined).then(() => void panel.refresh());
    }
  },
  onState: repaintName,
  message: toast,
  getFigures: () => docView.collectFigures(),
  setFigures: (figures) => docView.restoreFigures(figures),
  convert: async (text) => {
    // A file-handler launch converts at boot, usually before the socket's
    // first attach lands — and the engine that served this page is at
    // most a reconnect away. Wait for ready briefly instead of refusing.
    for (let waited = 0; !kernel.isReady && waited < 5000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return kernel.convert(text);
  },
  onSaveBlocked: () => {
    toast(`Allow saving to ${fileManager.name}?`, {
      label: 'Allow',
      run: () => void fileManager.grantWrite(),
    });
  },
  onDiskChange: (doc) => {
    // Same document, fresh from disk (knuth run receipts, an outside
    // editor): replace in place and keep the session — restarting on
    // every external save would kill exploration state mid-thought.
    docView.setDoc(doc);
    if (fileManager.dir || fileManager.root) docView.hydrateAll();
  },
  openPath: (path) => kernel.openPath(path),
  savePath: (path, text) => kernel.savePath(path, text),
  statPath: (path) => kernel.statPath(path),
  renamePath: (path, name) => kernel.renamePath(path, name),
  persist: () => kernel.persist(),
  ...(shell
    ? {
        pickPath: () => askShell({ type: 'open' }),
        pickSavePath: (name: string) => askShell({ type: 'saveAs', name }),
      }
    : {}),
  onOpened: () => {
    if (fileManager.root) {
      docView.hydrateAll();
      return;
    }
    if (!fileManager.dir) {
      toast(`Opened ${fileManager.name} — attach its folder for values.json and figs/`, {
        label: 'Attach folder',
        run: attachProjectFolder,
      });
    }
  },
});

void (async () => {
  const restored = await fileManager.restoreSession();
  if (openParam && fileManager.path !== openParam) {
    // Launched with a document: open it as the session's own (the kernel
    // already attached in its folder, so no restart), then drop the
    // parameter so a reload restores rather than reopens.
    for (let waited = 0; !kernel.isReady && waited < 8000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const opened = await fileManager.openPath(openParam);
    if (!opened && !restored) fileManager.newDoc();
  } else if (!restored) {
    fileManager.newDoc();
  }
  if (openParam) history.replaceState(null, '', window.location.pathname);
  // The folder handle reconnects after the document renders: resolve
  // figure receipts now that figs/ is reachable.
  if (restored && (fileManager.dir || fileManager.root)) docView.hydrateAll();
  restoring = false;
  if (fileManager.pendingHandle) {
    toast(`Reconnect ${fileManager.pendingHandle.name} to keep autosaving`, {
      label: 'Reconnect',
      run: () => void fileManager.reconnect(),
    });
  }
})();

// Recents dropdown: the one inherently dynamic list (Plass's exception
// to everything-on-the-bar).
let recentsMenu: HTMLElement | null = null;
function closeRecentsMenu() {
  recentsMenu?.remove();
  recentsMenu = null;
}
document.addEventListener('mousedown', (e) => {
  if (recentsMenu && !recentsMenu.contains(e.target as Node)) closeRecentsMenu();
});

async function showRecents(anchor: HTMLElement) {
  if (recentsMenu) {
    closeRecentsMenu();
    return;
  }
  const entries = await fileManager.recents();
  const menu = document.createElement('div');
  menu.className = 'file-menu';
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'file-menu-empty';
    empty.textContent = 'No recent documents';
    menu.append(empty);
  }
  for (const entry of entries) {
    const item = document.createElement('button');
    item.className = 'file-menu-item';
    item.textContent = entry.name;
    if (entry.path) item.title = entry.path;
    item.addEventListener('click', () => {
      closeRecentsMenu();
      void fileManager.openRecent(entry);
    });
    menu.append(item);
  }
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 10}px`;
  menu.style.left = `${Math.max(8, rect.left - 10)}px`;
  document.body.append(menu);
  recentsMenu = menu;
}

// The file lifecycle lives in the name slug — Plass's set (New, Open,
// Recent) plus Folder, which only exists because the browser grants the
// project-directory handle for values.json/figs through a user picker.
// Folder needs no button: Save on a homeless doc IS the folder grant,
// and opened/launched docs get the attach offer when it matters.
flyout($('doc-pod'), icon('open'), 'File — new, open, recent', [
  {
    glyph: icon('new'),
    label: 'New',
    title: 'New document — opens in a new window (its own session)',
    run: () => void window.open(location.pathname, '_blank'),
  },
  { glyph: icon('open'), label: 'Open', title: 'Open… (⌘O)', run: () => void fileManager.open() },
  {
    glyph: icon('clock'),
    label: 'Recent',
    title: 'Your documents',
    run: () => void showRecents($('doc-pod')),
  },
]);

// The view toggle lives in one corner in both views, so the way in and
// the way out are the same spot. CSS swaps its label by view and hides
// it when a markerless file offers no cell view to switch to.
const viewToggle = document.createElement('button');
viewToggle.id = 'view-toggle';
viewToggle.title = 'Switch between source and cell (or grid) view (⌘⇧E)';
viewToggle.innerHTML =
  `${icon('code')}<span class="lbl lbl-cells">Cells</span>` +
  `<span class="lbl lbl-grid">Grid</span><span class="lbl lbl-source">Source</span>`;
viewToggle.addEventListener('click', () => docView.setSource(!docView.isSource));
document.body.append(viewToggle);

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
    } else if (key === 'e' && e.shiftKey) {
      // Toggle between the raw source editor and the cell view.
      e.preventDefault();
      docView.setSource(!docView.isSource);
    } else if (key === 'z' && !e.shiftKey && pendingRestore && document.body.dataset.view !== 'grid') {
      // The undo the user means: reverse the structural change.
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
    // The folder offer rides the shared onOpened hook (a launched file
    // handle can't reach its parent; the picker startIn points there).
    const handle = file as FileSystemFileHandle;
    const opened = /\.ipynb$/i.test(handle.name)
      ? handle.getFile().then((f) => fileManager.importNotebook(f))
      : fileManager.loadHandle(handle);
    void opened.catch((e) => {
      console.warn('Launched file failed to open', e);
      toast('Could not open the launched file — try again');
    });
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((error) => {
      console.warn('Knuth service worker registration failed', error);
    });
  });
}
