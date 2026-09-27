// Boot: toolbar + document view + file manager + kernel, then the
// launch-queue consumer LAST — Chrome delivers queued launch files
// synchronously inside setConsumer, so everything it touches must
// already be live (hard-won Plass lesson).

import './frame-guard.ts';
import './styles.css';
import {
  SidecarKernel,
  type ConvertResult,
  type DependencyEvent,
  type DocumentResult,
  type EnvironmentEvent,
  type HeaderEvent,
  type Kernel,
  type PersistedResult,
  type RenamedResult,
  type SavedResult,
  type StatResult,
} from './kernel/kernel.ts';
import { LazyKernel } from './kernel/lazy-kernel.ts';
import { writeContract, type PathIO } from './contract.ts';
import { DocumentView, plainLanguageFor } from './document-view.ts';
import { delimiterFor } from './format/csv.ts';
import { serializeDocument } from './format/percent.ts';
import { DEFAULT_DOC_NAME, FileManager, basename, dirname } from './file-manager.ts';
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
    ${labeled('get-app', icon('download'), 'Get Knuth', 'Get Knuth for your Mac — this page runs Python in the tab; the app runs it on your computer, on your files')}
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

// Knuth.app (APP.md): the shell opens this page with ?open=<absolute path>
// and registers a message handler. Every request carries an id and the
// shell answers through window.knuthShell.reply. Both are feature-detected:
// a plain browser tab has neither and keeps the File System Access flow.
const openParam = new URLSearchParams(window.location.search).get('open');
const shell = window.webkit?.messageHandlers?.knuth ?? null;
let shellNextId = 1;
const shellWaiters = new Map<number, (result: unknown) => void>();
window.knuthShell = {
  reply: (id, result) => {
    const resolve = shellWaiters.get(id);
    shellWaiters.delete(id);
    resolve?.(result);
  },
};
function askShell<T>(message: Omit<KnuthShellMessage, 'id'>): Promise<T | null> {
  if (!shell) return Promise.resolve(null);
  const id = shellNextId++;
  return new Promise((resolve) => {
    shellWaiters.set(id, (result) => resolve((result ?? null) as T | null));
    shell.postMessage({ ...message, id });
  });
}
function askShellPath(message: Omit<KnuthShellMessage, 'id'>): Promise<string | null> {
  return askShell<{ path?: string | null }>(message).then((reply) =>
    typeof reply?.path === 'string' && reply.path ? reply.path : null,
  );
}
// Page failures reach the shell's log, which is what "Show Log" opens when
// someone asks why the window is blank.
if (shell) {
  window.addEventListener('error', (event) => {
    shell.postMessage({ type: 'error', message: String(event.message) });
  });
  window.addEventListener('unhandledrejection', (event) => {
    shell.postMessage({ type: 'error', message: String((event as PromiseRejectionEvent).reason) });
  });
}

// The kernel must start in the document's folder and in the document's
// own environment (ENVIRONMENT.md), and it attaches before the document
// opens: take both from the URL, else from the session stash a reload is
// about to restore.
function stashedPaths(): { root: string | null; path: string | null } {
  try {
    const raw = sessionStorage.getItem('knuth-doc');
    const snap = raw ? (JSON.parse(raw) as { root?: unknown; path?: unknown }) : {};
    return {
      root: typeof snap.root === 'string' ? snap.root : null,
      path: typeof snap.path === 'string' ? snap.path : null,
    };
  } catch {
    return { root: null, path: null };
  }
}
const stashed = stashedPaths();
const initialRoot = openParam ? dirname(openParam) : stashed.root;
const initialDocument = openParam ?? stashed.path;

// Served from loopback, an engine is behind this page and owns the session.
// Served from the web, there is no engine and never will be, so the preview
// runs Python in the tab instead (SAME_ORIGIN.md, "Pyodide in the
// preview"). The Pyodide backend is imported only in that case: the local
// app should not carry a runtime it will never load. `?python=browser`
// forces the in-tab backend anywhere, for testing the preview locally.
const servedLocally = ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
const pythonInBrowser =
  !servedLocally || new URLSearchParams(window.location.search).get('python') === 'browser';

// The session's surroundings, as the engine reports them: which Python a
// document runs on, a package being installed for a cell, the header the
// engine rewrote. Toasts and the status pill; never receipts.
let environmentSyncing = false;
let lastEnvironment: EnvironmentEvent | null = null;
let fallbackToldFor: string | null = null;
// A document that declares packages but runs on the system Python
// deserves a word; one without a header is just a document. The event
// can arrive before the document has opened (a launch attaches first),
// so the open also asks.
function reportFallback() {
  const event = lastEnvironment;
  if (!event || event.state !== 'fallback' || !event.reason) return;
  if (!fileManager?.path || event.document !== fileManager.path || !fileManager.hasHeader) return;
  if (fallbackToldFor === event.document) return;
  fallbackToldFor = event.document;
  toast(`Running on the system Python: ${event.reason}`);
}
const listeners = {
  onEnvironment: (event: EnvironmentEvent) => {
    environmentSyncing = event.state === 'syncing';
    if (event.state === 'syncing') {
      status.textContent = 'preparing environment…';
      status.title = `Setting up ${basename(event.document ?? '')}'s packages (uv)`;
      status.className = '';
      return;
    }
    lastEnvironment = event;
    if (kernelState === 'ready') paintKernelReady();
    reportFallback();
  },
  onDependency: (event: DependencyEvent) => {
    if (event.state === 'installing') toast(`Installing ${event.distribution}…`);
    else if (event.state === 'installed') {
      toast(`Installed ${event.distribution}${event.version ? ' ' + event.version : ''}`);
    } else toast(`Could not install ${event.distribution}: ${event.error ?? 'unknown error'}`);
  },
  onHeader: (event: HeaderEvent) => {
    // A saved document's header came from its file; an unsaved one's
    // (path null) belongs to the text on screen.
    if (fileManager && fileManager.path === event.path) {
      fileManager.spliceHeader(event.lines, event.modified ?? undefined);
    }
  },
};
// Which Python this is, in words, on the pill itself (APP.md): the one
// in the window, one uv installed, or — from a terminal's `knuth app` —
// whatever Python the engine was started with.
let pythonName = pythonInBrowser ? 'Pyodide' : 'Python';
let environmentTitle = pythonInBrowser
  ? 'Pyodide: Python running inside this window, loaded from the web'
  : 'Connected to the local Python engine';
function paintKernelReady() {
  status.textContent = pythonName;
  status.title = environmentTitle;
  status.className = 'ok';
}
function rememberEnvironment(event: EnvironmentEvent) {
  const fromUv = event.managed || /\/(engine\/bin|uv\/python)\//.test(event.python);
  pythonName = fromUv ? 'uv' : 'Python';
  environmentTitle = event.managed
    ? `${event.python}\nThis document's own environment, built by uv from its header` +
      (event.reason ? `\n${event.reason}` : '')
    : `${event.python}${event.reason ? '\n' + event.reason : ''}`;
}

type OnState = (state: Parameters<typeof onboarding.setState>[0], resumed?: boolean) => void;
function makeKernel(onState: OnState): Kernel {
  if (!pythonInBrowser) {
    return new SidecarKernel(undefined, onState, {
      root: initialRoot,
      document: initialDocument,
      listeners: {
        ...listeners,
        onEnvironment: (event) => {
          if (event.state !== 'syncing') rememberEnvironment(event);
          listeners.onEnvironment(event);
        },
      },
    });
  }
  const pending = import('./kernel/pyodide-kernel.ts').then(
    ({ PyodideKernel }) => new PyodideKernel(onState, listeners),
  );
  return new LazyKernel(pending, onState);
}

// With the shell present and no engine (Python in the tab), the shell is
// the file system: the same file manager hooks, answered by the app
// instead of files.py. The contract is then written by the page through
// the shell (contract.ts), since a kernel in the tab has no folder.
const filesViaShell = !!shell && pythonInBrowser;

// The hosted preview is the front door: it runs Python in the tab, and
// the real thing is one click away — a download, or a line for the
// terminal that never meets the Gatekeeper prompt (APP.md).
const APP_ZIP = 'https://github.com/tayweid/knuth/raw/main/app/Knuth.app.zip';
const APP_LINE = `curl -fsSL -o /tmp/Knuth.app.zip ${APP_ZIP} && rm -rf /Applications/Knuth.app && ditto -x -k /tmp/Knuth.app.zip /Applications`;
const ENGINE_LINE =
  'python3 -m pip install --upgrade --force-reinstall "knuth @ https://github.com/tayweid/knuth/archive/refs/heads/main.zip#subdirectory=python"';
if (servedLocally || shell) $('get-app').hidden = true;

let hadSession = false;
let kernelState: Parameters<typeof onboarding.setState>[0] = 'connecting';
const kernel = makeKernel((state, resumed) => {
  kernelState = state;
  onboarding.setState(state);
  shell?.postMessage({ type: 'status', state });
  if (state === 'ready') {
    if (!environmentSyncing) paintKernelReady();
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

/** .ipynb → percent text through the one converter, waiting briefly for a
 *  kernel that is still connecting (a launch converts at boot). */
async function convertWhenReady(text: string): Promise<ConvertResult | null> {
  for (let waited = 0; !kernel.isReady && waited < 8000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return kernel.convert(text);
}

interface ShellFile {
  path?: string;
  name?: string;
  text?: string;
  modified?: number | null;
  error?: string;
}

async function shellOpen(path: string): Promise<DocumentResult | null> {
  const reply = await askShell<ShellFile>({ type: 'read', path });
  if (!reply) return null;
  if (reply.error || typeof reply.text !== 'string') {
    return { error: reply.error ?? 'the file could not be read' };
  }
  if (!/\.ipynb$/i.test(path)) {
    return {
      path: reply.path ?? path,
      name: reply.name ?? basename(path),
      text: reply.text,
      modified: reply.modified ?? null,
    };
  }
  // A notebook converts in the tab and arrives unsaved under a sibling .py,
  // exactly as it does from the engine.
  const converted = await convertWhenReady(reply.text);
  if (!converted) return { error: 'importing a notebook needs Python, which is still loading' };
  if (typeof converted.text !== 'string') return { error: converted.error ?? 'no conversion result' };
  const target = path.replace(/\.ipynb$/i, '.py');
  return {
    path: target,
    name: basename(target),
    text: converted.text,
    modified: null,
    unsaved: true,
    commented: converted.commented,
  };
}

// Documents by path: the engine's files.py, or the shell when Python runs
// in the tab. One shape, two answerers.
const files = filesViaShell
  ? {
      open: shellOpen,
      save: (path: string, text: string) => askShell<SavedResult>({ type: 'write', path, text }),
      stat: (path: string) => askShell<StatResult>({ type: 'stat', path }),
      rename: (path: string, name: string) => askShell<RenamedResult>({ type: 'rename', path, name }),
    }
  : {
      open: (path: string) => kernel.openPath(path),
      save: (path: string, text: string) => kernel.savePath(path, text),
      stat: (path: string) => kernel.statPath(path),
      rename: (path: string, name: string) => kernel.renamePath(path, name),
    };

const shellIO: PathIO = {
  read: async (path) => {
    const reply = await askShell<ShellFile>({ type: 'read', path });
    return reply && !reply.error && typeof reply.text === 'string' ? reply.text : null;
  },
  write: async (path, text) => {
    const reply = await askShell<ShellFile>({ type: 'write', path, text });
    return !!reply && !reply.error;
  },
  remove: async (path) => {
    const reply = await askShell<ShellFile>({ type: 'remove', path });
    return !!reply && !reply.error;
  },
};

async function persistContract(): Promise<PersistedResult | null> {
  if (!filesViaShell) return kernel.persist();
  const root = fileManager.root;
  if (!root) return null;
  const artifacts = await kernel.artifacts();
  if (!artifacts) return null;
  try {
    await writeContract(root, artifacts.values, artifacts.figures, shellIO);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return {
    root,
    values: Object.keys(artifacts.values).length,
    figures: Object.keys(artifacts.figures).sort(),
  };
}

// After program cells run, mirror the session into the project folder
// (values.json + figs/). Debounced so a run-all writes once at the end.
// With no folder attached, the offer resurfaces here (throttled) — this
// is the moment the folder actually matters.
let artifactsTimer = 0;
let folderOfferAt = 0;
function syncArtifacts() {
  if (fileManager?.path || (fileManager?.root && fileManager.inShell)) {
    // By path, the contract goes into the document's folder: written by
    // the kernel, or by the page through the shell.
    clearTimeout(artifactsTimer);
    artifactsTimer = window.setTimeout(() => void fileManager.persist(), 300);
    return;
  }
  if (fileManager?.inShell) {
    // In the app, a document without a path has no folder yet: saving it
    // is what gives values.json and figs/ their home.
    if (Date.now() - folderOfferAt > 300_000) {
      folderOfferAt = Date.now();
      toast('Save the document to give values.json and figs/ a home', {
        label: 'Save',
        run: () => void fileManager.save(),
      });
    }
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
    const reply = await files.open(`${fileManager.root}/${path}`);
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

// A cell that could not import a module: offer to install it with uv,
// the one way Knuth installs anything (ENVIRONMENT.md). Never silently,
// and only with an engine — Pyodide installs from the web on import.
let pendingRestart: Promise<void> | null = null;
const MISSING = /ModuleNotFoundError: No module named '([A-Za-z_][A-Za-z0-9_]*)/;
docView.onRunFailed = (traceback, rerun) => {
  const install = kernel.install?.bind(kernel);
  const module = MISSING.exec(traceback)?.[1];
  if (!install || !module) return;
  toast(`${module} isn't installed`, {
    label: 'Install with uv',
    run: () => void installAndRerun(module, install, rerun),
  });
};

async function installAndRerun(
  module: string,
  install: (module: string, text?: string) => Promise<{ ok: boolean; restart?: boolean; error?: string } | null>,
  rerun: () => Promise<boolean>,
) {
  let restarted = false;
  if (pendingRestart) await pendingRestart;
  // An unsaved document has no file for uv to read its header from: the
  // engine keeps a copy of this text, and the header comes back into it.
  const text = fileManager.path ? undefined : serializeDocument(docView.doc);
  const result = await install(module, text);
  if (!result) {
    toast(`Could not install ${module}: the engine is not connected`);
    return;
  }
  if (!result.ok) return; // the dependency event already said why
  if (result.restart) {
    // The document had no environment: the session moves into the new one.
    await kernel.restart(fileManager.root ?? undefined, fileManager.path);
    restarted = true;
  }
  if (restarted) {
    docView.markAllStale();
    await docView.runStale();
  } else {
    await rerun();
  }
  void panel.refresh();
}

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
    // By path, the session also moves to the document's folder and into
    // the document's own environment.
    if (!restoring && kernel.isReady) {
      void kernel
        .restart(fileManager?.root ?? undefined, fileManager?.path ?? null)
        .then(() => void panel.refresh());
    }
  },
  onPathChanged: (path) => {
    // Same text, new path: the environment is per document (ENVIRONMENT.md).
    if (kernel.isReady) {
      pendingRestart = kernel.restart(fileManager.root ?? undefined, path);
      void pendingRestart.then(() => void panel.refresh());
    }
  },
  onState: repaintName,
  message: toast,
  getFigures: () => docView.collectFigures(),
  setFigures: (figures) => docView.restoreFigures(figures),
  convert: convertWhenReady,
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
  // A header that changed under a running document: only the preamble
  // moves, so the cell that is running keeps its live output.
  setPreamble: (lines) => docView.setPreamble(lines),
  openPath: files.open,
  savePath: files.save,
  statPath: files.stat,
  renamePath: files.rename,
  persist: persistContract,
  ...(shell
    ? {
        pickPath: () => askShellPath({ type: 'open' }),
        pickSavePath: (name: string) => askShellPath({ type: 'saveAs', name }),
      }
    : {}),
  onOpened: () => {
    reportFallback();
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
    // parameter so a reload restores rather than reopens. Through the
    // engine the open needs the socket; through the shell it needs nothing.
    for (let waited = 0; !filesViaShell && !kernel.isReady && waited < 8000; waited += 100) {
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

function commandRow(command: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'command-row';
  const code = document.createElement('code');
  code.textContent = command;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'command-copy';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(command).then(
      () => (copy.textContent = 'Copied'),
      () => (copy.textContent = 'Select'),
    );
    window.setTimeout(() => (copy.textContent = 'Copy'), 1600);
  });
  row.append(code, copy);
  return row;
}

function showGetMenu(anchor: HTMLElement) {
  if (recentsMenu) {
    closeRecentsMenu();
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'file-menu get-menu';
  menu.innerHTML = `
    <h2>Knuth for your Mac</h2>
    <p>This page runs Python in the tab. The app runs it on your computer, on your own files, with your own packages.</p>
    <a class="get-download" href="${APP_ZIP}">${icon('download')}<span>Download Knuth.app</span></a>
    <p class="get-note">Unzip and drag to Applications. The first launch is refused once because the app is not signed with Apple: open System Settings → Privacy &amp; Security and click <b>Open Anyway</b>.</p>
    <h3>Or from the terminal</h3>
    <p class="get-note">No prompt this way — only browser downloads are quarantined.</p>
  `;
  menu.append(commandRow(APP_LINE));
  const other = document.createElement('h3');
  other.textContent = 'Windows or Linux';
  const otherNote = document.createElement('p');
  otherNote.className = 'get-note';
  otherNote.textContent = 'The engine, from pip; then knuth app opens this page from your own computer.';
  menu.append(other, otherNote, commandRow(ENGINE_LINE));
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 10}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - rect.right - 10)}px`;
  document.body.append(menu);
  recentsMenu = menu;
}

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

$('get-app').addEventListener('click', () => showGetMenu($('get-app')));
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
