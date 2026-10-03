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
import { Session } from './session.ts';
import { attachScrollRail } from './scroll-rail.ts';
import { cellMarks } from './rail-marks.ts';
import { menus } from './menu.ts';
import { icon } from './icons.ts';
import { Onboarding } from './onboarding.ts';
import { keepPlace } from './place.ts';
import { answerRewinds, historyNote, reportCellRun, shell, type ShellMessage } from './shell.ts';

// The History tile's glyph: the record's river as the history view draws
// it — time running down, three commits on one stream, the lowest filled,
// the mouth, now. Written whole rather than through icon(), because
// Plass's bar draws the very same string: its copy is HISTORY_GLYPH in
// plass/src/toolbar.ts, and the two stay byte-identical (a change is made
// to both). Not a clock with an arrow: that is the Restart session tile's
// arrow (icons.ts, `restart`) with hands, and the two would share a window
// meaning different things. The nodes are r 2.25 at the icons' 1.7 stroke,
// so at 18 px each ring keeps a hole 2.1 px across; the segments end
// inside the rings' strokes, so the holes stay clear.
const HISTORY_GLYPH =
  '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="3.5" r="2.25"/><line x1="12" y1="6.25" x2="12" y2="9.25"/><circle cx="12" cy="12" r="2.25"/><line x1="12" y1="14.75" x2="12" y2="17.75"/><circle cx="12" cy="20.5" r="2.25" fill="currentColor"/></svg>';

function labeled(id: string, glyph: string, label: string, title: string, className = 'tb-btn'): string {
  return `<button type="button" class="${className}" id="${id}" title="${title}">${glyph}<span class="lbl">${label}</span></button>`;
}

// Zen's shape, as Plass has it (docs/ZEN-DRAFT.md): the bar across the top
// holds the document's way in and out beside the traffic lights — the File
// tile, whose text menu holds New, Open, Recent, Save and, where they
// apply, Get Knuth, Install and the app's update (below); the name pill
// with the save mark and the folder; beside it, inside Knuth.app, the
// History tile (Taylor: "it belongs as a tile on the topbar beside the
// address"), Plass's too, the same glyph — and, at the right, the session pill
// (session.ts, docs/SESSION.md): the kernel's status, then the session's
// names in cell order. In Knuth.app the bar is the window's title bar
// (styles.css).
const toolbar = document.getElementById('toolbar')!;
toolbar.setAttribute('aria-label', 'Document');
toolbar.innerHTML = `
  ${labeled('file-tile', icon('open'), 'File', 'File — new, open, recent, save', 'tb-btn tb-tile')}
  <div class="doc-pod" id="doc-pod"><span class="name" id="file-name" title="Click to rename">${DEFAULT_DOC_NAME}</span><span class="doc-mark" id="doc-mark" aria-hidden="true"></span><span class="doc-folder" id="doc-folder" hidden><span dir="ltr"></span></span></div>
  <button type="button" class="tb-btn tb-tile" id="history-tile" title="History (⇧⌘H)" aria-label="History" aria-keyshortcuts="Shift+Meta+H">${HISTORY_GLYPH}<span class="lbl">History</span></button>
  <div class="tb-end">
    <button type="button" id="session-pill"><span id="kernel-status">connecting…</span><span class="sp-sep" aria-hidden="true"></span><span class="sp-mark" aria-hidden="true">${icon('braces')}</span><span class="sp-names"></span></button>
  </div>
`;

// The rail down the left: the cell and run tools in their groups under a
// hairline, scrolling as one when the window is short, and the Session
// card's toggle pinned at the foot with the view switch, as Zen pins its
// bottom icons. The captions are longer words than the old bar's, since
// there is room beside a tile; the titles are unchanged. The view switch
// is the same spot in every view, so the way in and the way out are one
// (Plass's Plain text / Paper switch); its caption names the view it
// switches TO (styles.css), and it is lit in source view.
const VIEW_TITLE = 'Switch between source and cell (or grid) view (⌘⇧E)';
const rail = document.getElementById('rail')!;
rail.innerHTML = `
  <div class="tb-rail-groups">
    <div class="tb-rail-group" id="cells-pod" role="group" aria-label="Cells">
      ${labeled('add-code', icon('code'), 'Code cell', 'Program cell below the current one')}
      ${labeled('add-scratch', icon('scratch'), 'Scratch cell', 'Scratch cell — explores the session, never persists')}
      ${labeled('add-text', icon('text'), 'Text cell', 'Markdown text cell')}
    </div>
    <div class="tb-rule" role="separator"></div>
    <div class="tb-rail-group" id="run-pod" role="group" aria-label="Run">
      ${labeled('run-stale', icon('play'), 'Run stale', 'Run stale program cells in order')}
      ${labeled('run-all', icon('playall'), 'Run all', 'Run all program cells from the top')}
      ${labeled('stop', icon('stop'), 'Stop', 'Interrupt the running cell')}
      ${labeled('restart', icon('restart'), 'Restart session', 'Fresh session (kernel process replaced)')}
    </div>
  </div>
  <div class="tb-rail-foot">
    ${labeled('toggle-panel', icon('panel'), 'Session', 'Show/hide the Session card: its names, data and figures')}
    <button type="button" class="tb-btn" id="view-toggle" title="${VIEW_TITLE}">${icon('source')}<span class="lbl lbl-cells">Cells</span><span class="lbl lbl-grid">Grid</span><span class="lbl lbl-source">Source</span></button>
  </div>
`;

// A short window cuts the groups: a fade at the cut edge says the rest is
// a scroll away (styles.css). Read on scroll and resize only.
const railGroups = rail.querySelector<HTMLElement>('.tb-rail-groups')!;
const railCue = () => {
  const { scrollTop, scrollHeight, clientHeight } = railGroups;
  railGroups.classList.toggle('tb-more-above', scrollTop > 1);
  railGroups.classList.toggle('tb-more-below', scrollTop + clientHeight < scrollHeight - 1);
};
railGroups.addEventListener('scroll', railCue, { passive: true });
const railResized = new ResizeObserver(railCue);
railResized.observe(railGroups);
for (const group of railGroups.children) railResized.observe(group);

// A rail tile's caption sits to its right, fixed to the window: the groups
// scroll, and a scrolling box clips what hangs out of it. Placed when the
// tile is hovered or focused, never on the typing path.
function placeRailCaption(target: EventTarget | null, from: EventTarget | null = null) {
  const button = target instanceof Element ? target.closest<HTMLElement>('.tb-btn') : null;
  if (!button || (from instanceof Node && button.contains(from))) return;
  const rect = button.getBoundingClientRect();
  for (const label of button.querySelectorAll<HTMLElement>('.lbl')) {
    label.style.top = `${rect.top + rect.height / 2}px`;
    label.style.left = `${rect.right + 12}px`;
  }
}
rail.addEventListener('mouseover', (e) => placeRailCaption(e.target, e.relatedTarget));
rail.addEventListener('focusin', (e) => placeRailCaption(e.target));

// Plass's rule: a tool that cannot act rests, dim, rather than going away,
// so the strip reads as the rail in every view. Source and grid views (a
// plain file is always in source view) rest the cell and run tiles and
// the Session card's; the view switch rests only when there is no other
// view to switch to — a script without # %% markers, a plain file.
// aria-disabled rather than disabled: Tab walks the same tiles in every
// view. A click on a resting tile does nothing, and its caption stays
// hidden (styles.css). The body's data-view, data-cells and data-grid are
// the document view's (DocumentView.syncView); written only on change.
const CELL_TOOLS = ['add-code', 'add-scratch', 'add-text', 'run-stale', 'run-all', 'stop', 'restart', 'toggle-panel'];
function rest(tile: HTMLElement, resting: boolean) {
  if ((tile.getAttribute('aria-disabled') === 'true') === resting) return;
  if (resting) tile.setAttribute('aria-disabled', 'true');
  else tile.removeAttribute('aria-disabled');
}
function paintRail() {
  const { view, cells, grid } = document.body.dataset;
  for (const id of CELL_TOOLS) rest(document.getElementById(id)!, view === 'source' || view === 'grid');
  const toggle = document.getElementById('view-toggle')!;
  const alone = view === 'source' && cells !== 'true' && grid !== 'true';
  rest(toggle, alone);
  const title = alone ? 'No cell view: this file has no # %% cells' : VIEW_TITLE;
  if (toggle.title !== title) toggle.title = title;
}
new MutationObserver(paintRail).observe(document.body, {
  attributes: true,
  attributeFilter: ['data-view', 'data-cells', 'data-grid'],
});
rail.addEventListener('click', (e) => {
  const tile = (e.target as Element).closest('.tb-btn');
  if (tile?.getAttribute('aria-disabled') === 'true') {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

const $ = (id: string) => document.getElementById(id)!;
const toastEl = $('toast');
let toastTimer = 0;

/** A toast that stays until the next one replaces it, with a spinner: for
 *  work the person is waiting on (installing a package). */
function progress(text: string) {
  toastEl.textContent = text;
  toastEl.classList.add('working');
  toastEl.hidden = false;
  clearTimeout(toastTimer);
}

function toast(
  text: string,
  action?: { label: string; run: () => void },
  options: { stay?: boolean } = {},
) {
  toastEl.classList.remove('working');
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
  // `stay`: an offer the person has to see (installing a package) waits
  // until the next toast replaces it rather than timing out unseen.
  if (!options.stay) {
    // A passing message: gone when it times out — back to what uv is
    // doing, if it is still at it.
    toastTimer = window.setTimeout(() => {
      if (syncShown) progress(syncStep);
      else toastEl.hidden = true;
    }, action ? 8000 : 2500);
  }
}

// The File tile's menu, Plass's File (menu.ts): New window, Open…,
// Recent ›, Save, and below a rule the three that apply in one place each
// — Get Knuth for your Mac (the hosted demo), Install Knuth (a locally
// served tab the browser offers to install) and the update (Knuth.app) —
// built here, before the onboarding that drives Install, and given their
// conditions and actions below, where those are decided. Folder needs no
// item: Save on a homeless doc IS the folder grant (the browser grants the
// project folder for values.json and figs/ through a picker), and opened
// or launched documents get the attach offer when it matters.
const menu = menus();
const fileMenu = menu.create('File', $('file-tile') as HTMLButtonElement);
const recentMenu = menu.create('Recent', $('file-tile') as HTMLButtonElement, fileMenu);
const getMenu = menu.create('Get Knuth', $('file-tile') as HTMLButtonElement, fileMenu);
menu.item(fileMenu, 'New window', () => void window.open(location.pathname, '_blank'), {
  title: 'New document — opens in a new window (its own session)',
});
menu.item(fileMenu, 'Open…', () => void fileManager.open(), { title: 'Open… (⌘O)', shortcut: '⌘O' });
menu.item(fileMenu, 'Recent documents', () => {}, { title: 'Your documents', submenu: recentMenu });
menu.item(fileMenu, 'Save', () => void fileManager.save(), { title: 'Save (⌘S)', shortcut: '⌘S' });
// The project's autosave record as a path, with a rewind: the shell's own
// window (its View › History…, on the same ⇧⌘H), so only inside Knuth.app,
// from this item and from the bar's History tile beside the name pill —
// one way in, two places (openHistory, below). The tile takes no focus
// from a click, as the File tile does not: the cell keeps it.
const historyItem = menu.item(fileMenu, 'History…', () => void openHistory(), {
  id: 'open-history',
  title: 'History… (⇧⌘H) — this project’s autosave record, and a rewind to any point on it',
  shortcut: '⇧⌘H',
});
const historyTile = $('history-tile') as HTMLButtonElement;
historyItem.hidden = historyTile.hidden = !shell;
historyTile.addEventListener('mousedown', (e) => e.preventDefault());
historyTile.addEventListener('click', () => void openHistory());
const ioRule = menu.divider(fileMenu);
const getItem = menu.item(fileMenu, 'Get Knuth for your Mac', () => {}, {
  id: 'get-app',
  title: 'Get Knuth for your Mac — this page runs Python in the tab; the app runs it on your computer, on your files',
  submenu: getMenu,
});
const installItem = menu.item(fileMenu, 'Install Knuth', () => {}, {
  id: 'install-app',
  title: 'Install Knuth as an app: its own icon and window (the Python engine stays separate and local)',
});
const updateItem = menu.item(fileMenu, 'Check for updates…', () => {}, {
  id: 'update-app',
  title: 'Knuth.app: compare this build with the site’s and install a newer one',
});
for (const item of [getItem, installItem, updateItem]) item.hidden = true;
// The rule shows only above one of them.
fileMenu.refresh = () => {
  ioRule.hidden = [getItem, installItem, updateItem].every((item) => item.hidden);
};

const status = $('kernel-status');
const onboarding = new Onboarding(
  $('onboarding'),
  $('install-app') as HTMLButtonElement,
);
// The install click is what gives Knuth its own icon and a tab-less window.
// It is optional, so it lives in the File menu — but an item nobody
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
// and answers requests over the Claerbout protocol (shell.ts). A plain
// browser tab has no shell and keeps the File System Access flow.
const openParam = new URLSearchParams(window.location.search).get('open');
function askShell<T>(message: ShellMessage): Promise<T | null> {
  return shell ? shell.request<T>(message) : Promise.resolve(null);
}
function askShellPath(message: ShellMessage): Promise<string | null> {
  return shell ? shell.pickPath(message) : Promise.resolve(null);
}
/** File → History… and the History tile, one path: the shell opens the
 *  view for this window's project, or says why there is none (shell.ts,
 *  historyNote). An older shell answers null: it has no view, so after
 *  saying so the tile and the item go, as Plass's item does. */
async function openHistory() {
  const answer = await askShell<{ opened?: boolean; reason?: string; detail?: string }>({ type: 'history', action: 'open' });
  if (answer === null) historyItem.hidden = historyTile.hidden = true;
  const note = historyNote(answer);
  if (note) toast(note);
}
// Page failures reach the shell's log, which is what "Show Log" opens when
// someone asks why the window is blank.
if (shell) {
  const report = shell;
  window.addEventListener('error', (event) => {
    report.notify({ type: 'error', message: String(event.message) });
  });
  window.addEventListener('unhandledrejection', (event) => {
    report.notify({ type: 'error', message: String((event as PromiseRejectionEvent).reason) });
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
// The "Setting up…" toast: its latest step, and whether it is up yet.
let syncStep = '';
let syncShown = false;
let syncTimer = 0;
/** The file uv manages for this session: the document, or its scratch
 *  stand-in when the document has no header yet. */
let environmentDocument: string | null = null;
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
    const wasSyncing = environmentSyncing;
    environmentSyncing = event.state === 'syncing';
    if (event.state === 'syncing') {
      status.textContent = 'preparing environment…';
      status.title = 'uv is setting up this document’s packages';
      status.className = 'working';
      // What uv is doing, step by step: never just a spinner. Only once it
      // has taken a moment — a built environment syncs in a blink, and a
      // toast flashing on every window would be noise.
      syncStep = `Setting up packages${event.detail ? ': ' + event.detail : '…'}`;
      if (syncShown) progress(syncStep);
      else if (!syncTimer) {
        syncTimer = window.setTimeout(() => {
          syncShown = true;
          progress(syncStep);
        }, 1000);
      }
      return;
    }
    clearTimeout(syncTimer);
    syncTimer = 0;
    if (wasSyncing && syncShown && toastEl.classList.contains('working')) toastEl.hidden = true;
    syncShown = false;
    lastEnvironment = event;
    environmentDocument = event.managed ? event.document : null;
    if (kernelState === 'ready') paintKernelReady();
    reportFallback();
  },
  onDependency: (event: DependencyEvent) => {
    // Only downloads are reported: the rerun says the rest.
    if (event.state === 'installing') {
      progress(`Downloading ${event.distribution}${event.detail ? ': ' + event.detail : '…'}`);
    }
    else if (event.state === 'installed') toastEl.hidden = true;
    else toast(`Could not download ${event.distribution}: ${event.error ?? 'unknown error'}`);
  },
  onHeader: (event: HeaderEvent) => {
    if (!fileManager) return;
    if (event.path !== null && event.path === fileManager.path) {
      // The engine rewrote this very file: adopt it.
      fileManager.spliceHeader(event.lines, event.modified ?? undefined);
    } else if (event.path === null || event.path === environmentDocument) {
      // The session's scratch environment: the text carries it to disk.
      fileManager.spliceHeader(event.lines, undefined, true);
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
    ? `${event.python}\nThis document's own environment, built by uv from its header`
    : `${event.python}${event.reason ? '\n' + event.reason : ''}`;
}

type OnState = (state: Parameters<typeof onboarding.setState>[0], resumed?: boolean) => void;
function makeKernel(onState: OnState): Kernel {
  if (!pythonInBrowser) {
    return new SidecarKernel(undefined, onState, {
      root: initialRoot,
      document: initialDocument,
      // The latest stash: current within a keystroke's debounce, and there
      // before the document is restored on a relaunch.
      documentText: () => {
        try {
          const raw = sessionStorage.getItem('knuth-doc');
          const text = raw ? (JSON.parse(raw) as { text?: unknown }).text : null;
          return typeof text === 'string' ? text : null;
        } catch {
          return null;
        }
      },
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
// Opening, though, is always the shell's when there is one: the engine
// answers only once the session's environment is built, which for a
// document with packages uv must download can take minutes, and the
// document should be on screen meanwhile. (Saving stays with the engine,
// which gives a new file its header.)
const opensViaShell = !!shell;

// The hosted preview is the front door: it runs Python in the tab, and
// the real thing is one click away — a download, or a line for the
// terminal that never meets the Gatekeeper prompt (APP.md). Every deploy
// publishes the app beside this page, so both are this page's version.
const APP_ZIP = 'https://knuth.tayweid.io/app/Knuth.app.zip';
const APP_LINE = 'curl -fsSL https://knuth.tayweid.io/install | bash';
const ENGINE_LINE =
  'python3 -m pip install --upgrade --force-reinstall "knuth @ https://github.com/tayweid/knuth/archive/refs/heads/main.zip#subdirectory=python"';
// File → Get Knuth for your Mac, on the hosted demo only (Plass's Get
// Plass): served by an engine or inside Knuth.app there is nothing to get.
getItem.hidden = servedLocally || !!shell;
/** A line for the terminal onto the clipboard, or into the toast to copy
 *  by hand when the clipboard says no. */
function copyLine(line: string, done: string) {
  void navigator.clipboard.writeText(line).then(
    () => toast(done),
    () => toast(line),
  );
}
menu.back(getMenu, 'File');
menu.heading(getMenu, 'Knuth for your Mac');
menu.hint(getMenu, 'This page runs Python in the tab. The app runs it on your computer, on your own files, with your own packages. For Macs with Apple silicon.');
menu.item(getMenu, 'Download Knuth.app', () => void window.open(APP_ZIP, '_blank', 'noopener'), {
  title: 'Download Knuth.app (a zip; unzip and drag to Applications)',
});
menu.hint(getMenu, 'Unzip and drag to Applications. The first launch is refused once because the app is not signed with Apple: open System Settings → Privacy & Security and click Open Anyway. Then it gets Electron, the window it runs in — shared with Plass or ManimLive if you have one, otherwise a 130 MB download, once.');
menu.item(getMenu, 'Copy the install line', () => copyLine(APP_LINE, 'Install line copied — paste it in Terminal'), {
  title: 'The terminal way: no prompt, since only browser downloads are quarantined',
});
menu.hint(getMenu, APP_LINE).classList.add('tb-menu-line');
menu.divider(getMenu);
menu.heading(getMenu, 'Windows or Linux');
menu.hint(getMenu, 'The engine, from pip; then knuth app opens this page from your own computer.');
menu.item(getMenu, 'Copy the pip line', () => copyLine(ENGINE_LINE, 'pip line copied — paste it in a terminal'), {
  title: 'Install the engine with pip',
});
menu.hint(getMenu, ENGINE_LINE).classList.add('tb-menu-line');
// The manifest, and with it installability, only where the app is served
// by its engine (SAME_ORIGIN.md: one installable app, served locally; the
// hosted demo is a demo). Inside Knuth.app there is nothing to install.
if (servedLocally && !shell) {
  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = './manifest.webmanifest';
  document.head.append(link);
}

// Knuth.app updating itself (the shell's update.js; also Knuth menu → Check
// for Updates…), as Plass's File → Check for updates…: the item asks the
// shell to compare this build with the site's, and once the shell says a
// newer one is out — asked, or by itself after launch — it reads Install
// update, and a click has the shell download that build, swap it in and
// relaunch, with the steps in the toast; this window is reopened on its
// document.
if (shell) {
  const host = shell;
  type UpdateStep = import('./shell.ts').UpdateStep;
  let offered: string | null = null;
  const label = updateItem.querySelector('.tb-menu-label')!;
  const show = (text: string, enabled = true) => {
    label.textContent = text;
    updateItem.disabled = !enabled;
  };
  const built = (step: UpdateStep) => (step.latest?.built ? ` (built ${step.latest.built.slice(0, 10)})` : '');
  updateItem.hidden = false;
  updateItem.addEventListener('click', () => {
    if (offered) {
      show('Updating…', false);
      host.notify({ type: 'update', action: 'install' });
      return;
    }
    show('Checking…', false);
    void host.request<UpdateStep>({ type: 'update' }).then((step) => {
      if (step?.state === 'available') {
        offered = step.latest?.build ?? 'new';
        show(`Install update${built(step)}`);
        toast(`A new Knuth is available${built(step)} — File → Install update`);
        return;
      }
      show('Check for updates…');
      if (step?.state === 'current') toast(`Knuth is up to date${step.current?.build ? ` (build ${step.current.build})` : ''}`);
      else if (step?.state === 'development') toast('Running from a checkout: nothing to update');
      else toast(step?.text ? `Could not check for updates: ${step.text}` : 'Could not check for updates');
    });
  });
  host.on('update', (detail) => {
    const step = (detail ?? {}) as UpdateStep;
    switch (step.state) {
      case 'available':
        offered = step.latest?.build ?? 'new';
        show(`Install update${built(step)}`);
        break;
      case 'downloading':
      case 'unpacking':
      case 'completing':
      case 'installing':
        show('Updating…', false);
        progress(step.text ?? 'Updating Knuth…');
        break;
      case 'ready':
        show('Relaunching…', false);
        progress(step.text ?? 'Knuth relaunches now…');
        break;
      case 'failed':
        show(offered ? `Install update${built(step)}` : 'Check for updates…');
        toast(`Could not update Knuth: ${step.text ?? 'unknown error'}`);
        break;
      default:
        break;
    }
  });
}

let hadSession = false;
let kernelState: Parameters<typeof onboarding.setState>[0] = 'connecting';
/** Built once the document view is (below); the kernel's callbacks may
 *  run before then. */
let session: Session | undefined;
const kernel = makeKernel((state, resumed) => {
  kernelState = state;
  onboarding.setState(state);
  shell?.notify({ type: 'status', state });
  if (state === 'ready') {
    if (!environmentSyncing) paintKernelReady();
    if (resumed && !hadSession) {
      // Reloaded tab reattached to its living session.
      toast('Session resumed');
    } else if (!resumed && hadSession) {
      // Genuinely fresh process behind us (restart, grace expired, …).
      docView.markAllStale();
      session?.restarted();
      toast('Kernel session reset');
    }
    hadSession = true;
    void session?.refresh();
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
  session?.statusChanged();
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
      open: (path: string) => (opensViaShell ? shellOpen(path) : kernel.openPath(path)),
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
/** Resolves once the write the debounce is holding has landed; a write
 *  scheduled again before then is the same promise. What the autosave
 *  report of a run waits for (below). */
let artifactsSettled: Promise<void> = Promise.resolve();
let artifactsLanded: (() => void) | null = null;
function scheduleArtifacts(write: () => Promise<unknown>) {
  clearTimeout(artifactsTimer);
  if (!artifactsLanded) {
    artifactsSettled = new Promise((resolve) => {
      artifactsLanded = resolve;
    });
  }
  artifactsTimer = window.setTimeout(() => {
    const landed = artifactsLanded;
    artifactsLanded = null;
    void write().finally(() => landed?.());
  }, 300);
}
function syncArtifacts() {
  if (fileManager?.path || (fileManager?.root && fileManager.inShell)) {
    // By path, the contract goes into the document's folder: written by
    // the kernel, or by the page through the shell.
    scheduleArtifacts(() => fileManager.persist());
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
  scheduleArtifacts(async () => {
    const artifacts = await kernel.artifacts();
    if (artifacts) await fileManager.writeArtifacts(artifacts.values, artifacts.figures);
  });
}

function attachProjectFolder() {
  void fileManager.attachFolder().then((ok) => {
    if (ok) {
      syncArtifacts();
      docView.hydrateAll();
    }
  });
}

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
  (run) => session?.ran(run),
  (restore, message) => {
    pendingRestore = restore;
    clearTimeout(restoreTimer);
    restoreTimer = window.setTimeout(() => (pendingRestore = null), 15000);
    toast(message);
  },
  loadFigureFromDir,
);

// The session (session.ts, docs/SESSION.md): every run's receipt, beside
// the cell and then up into the pill; a chip at each cell that made
// something; the Session card from the pill. Built after docView, which
// it reads cells from (and which reports runs to it).
session = new Session(kernel, docView, $('toggle-panel') as HTMLButtonElement, {
  ready: () => kernelState === 'ready',
  showOnboarding: () => onboarding.show(),
  hasFolder: () => !!(fileManager?.path || (fileManager?.root && fileManager.inShell) || fileManager?.dir),
});
docView.decorate = (id, row) => session?.decorate(id, row);
docView.onDocument = () => session?.documentChanged();

// The scroll rail in the frame's gutter (scroll-rail.ts, Plass's rail, with
// Knuth's marks from rail-marks.ts): the cells and what the session says a
// run left. It watches the column's size itself; a run starting or ending
// changes a tick's colour without a size, so the runs tell it (onRunDone,
// below), as does the cursor moving to another cell and the view switch.
// Typing writes nothing to it.
const scrollRail = attachScrollRail(cellMarks(docView, (id) => session?.tables(id) ?? []), $('doc'), $('sheet'));
docView.onRunStart = (id) => {
  session?.runStarting(id);
  scrollRail.cells();
};
$('sheet').addEventListener('focusin', () => scrollRail.selection());
const railAway = () => scrollRail.mode(Boolean(document.body.dataset.view));
new MutationObserver(railAway).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
railAway();

// A cell that could not import a module (ENVIRONMENT.md). A package uv
// already has on this Mac goes into the document's environment at once,
// with no question: using what is downloaded needs no permission. Only a
// download asks (Taylor, 2026-09-27). Either way the header gains the
// pin and the cell runs again in the same session. Only with an engine —
// Pyodide downloads from the web on import.
const MISSING = /ModuleNotFoundError: No module named '([A-Za-z_][A-Za-z0-9_]*)/;
// Modules already added without asking: if one still will not import
// (its package is named differently), ask rather than loop.
const addedQuietly = new Set<string>();
// Every completed run is a point on the project's autosave record
// (docs/AUTOSAVE.md): the shell commits `knuth: cell run [n]` if anything
// in the project changed. Told once the run's writes have landed — the
// document (noteChange's autosave, 1.2 s) and the project contract
// (syncArtifacts' persist, 300 ms) — so the commit holds what the run
// produced; runs completing while those settle (a run-all) are reported
// together, `cell run [1, 2, 3]`, and `cell run [3] (error)` when one of
// them raised, which the history view rings in red. Nothing in a browser
// tab.
const ranCells: number[] = [];
let ranRaised = false;
let runReport: Promise<void> | null = null;
docView.onRunDone = (cell, ok) => {
  scrollRail.cells();
  if (!shell) return;
  ranCells.push(cell);
  if (!ok) ranRaised = true;
  if (runReport) return;
  runReport = (async () => {
    try {
      await Promise.all([fileManager.settled(), artifactsSettled]);
    } finally {
      runReport = null;
      const raised = ranRaised;
      ranRaised = false;
      reportCellRun(shell, ranCells.splice(0), raised);
    }
  })();
};
docView.onRunFailed = (traceback, rerun, working) => {
  const install = kernel.install?.bind(kernel);
  const module = MISSING.exec(traceback)?.[1];
  if (!install || !module) return;
  const cell = { rerun, working };
  if (addedQuietly.has(module)) {
    offerDownload(module, install, cell);
    return;
  }
  addedQuietly.add(module);
  void (async () => {
    // The cell's own spinner says uv is at work on it; nothing else does.
    working(true);
    const result = await install(module, serializeDocument(docView.doc));
    if (result?.ok) {
      await afterInstall(result, cell);
    } else if (result?.download) {
      offerDownload(module, install, cell);
    } else {
      working(false);
      toast(`Could not add ${module}: ${result?.error ?? 'the engine is not connected'}`);
    }
  })();
};

type Install = (
  module: string,
  text?: string,
  download?: boolean,
) => Promise<{ ok: boolean; restart?: boolean; error?: string; download?: boolean } | null>;

/** The cell a missing import came from: run it again, or show uv working. */
interface FailedCell {
  rerun: () => Promise<boolean>;
  working: (on: boolean) => void;
}

function offerDownload(module: string, install: Install, cell: FailedCell) {
  // Waiting on the person, not on uv: no spinner until they say yes.
  cell.working(false);
  toast(
    `${module} isn't on this Mac`,
    { label: 'Download with uv', run: () => void downloadAndRerun(module, install, cell) },
    { stay: true },
  );
}

async function downloadAndRerun(module: string, install: Install, cell: FailedCell) {
  // Up at once and until it is done: the engine's events take it over.
  progress(`Downloading ${module}…`);
  cell.working(true);
  // The page's own text goes along: its header is the one to keep in step
  // with when the session's environment is a scratch one.
  const result = await install(module, serializeDocument(docView.doc), true);
  if (!result?.ok) cell.working(false);
  if (!result) {
    toast(`Could not download ${module}: the engine is not connected`);
    return;
  }
  if (!result.ok) return; // the dependency event already said why
  await afterInstall(result, cell);
}

async function afterInstall(result: { restart?: boolean }, cell: FailedCell) {
  if (result.restart) {
    // Only an engine without environments for every session asks this.
    cell.working(false);
    await kernel.restart(fileManager.root ?? undefined, fileManager.path);
    docView.markAllStale();
    await docView.runStale();
  } else {
    // Same session, same variables: the cell just runs again (and its
    // spinner carries straight on into the run).
    await cell.rerun();
  }
  void session?.refresh();
}

function repaintName() {
  const label = $('file-name');
  // The name's own text is exactly the name (a rename's input replaces it
  // while it is open).
  if (!label.querySelector('input')) label.textContent = fileManager.name;
  // The save mark, Plass's dot: green when the file on disk holds the
  // document, red when it does not — unsaved changes, or no file yet
  // (⌘S then picks where it lives).
  const homeless = !fileManager.path && !fileManager.handle;
  const unsaved = homeless || fileManager.dirty;
  const pod = $('doc-pod');
  pod.classList.toggle('doc-saved', !unsaved);
  pod.classList.toggle('doc-unsaved', unsaved);
  $('doc-mark').title = homeless ? 'Not saved yet — ⌘S picks its folder' : unsaved ? 'Unsaved changes' : 'Saved';
  // The folder beside the name, in a sibling so the name's own text stays
  // exactly the name: the path's folder (home as ~), or an attached
  // folder's name, or nothing. It is what gives way when the pill is short,
  // from its start, so the nearest folder stays (styles.css).
  const folder = $('doc-folder');
  const where = fileManager.path ? fileManager.root ?? dirname(fileManager.path) : null;
  folder.firstElementChild!.textContent = where ? tilde(where) : fileManager.dir?.name ?? '';
  folder.title = where ?? '';
  folder.hidden = !folder.textContent;
  // Just the file name: the installed app's window prepends its own
  // app name, so anything more reads twice.
  document.title = fileManager.name;
}

/** A folder as a person reads it: their home as ~. The page has no way to
 *  ask for the home folder, so a home is what macOS and Linux put there —
 *  /Users/<name> or /home/<name> — but not /Users/Shared, which is no
 *  one's. */
function tilde(path: string): string {
  return path.replace(/^\/(?:Users|home)\/(?!Shared(?:\/|$))[^/]+(?=\/|$)/, '~');
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
        .then(() => void session?.refresh());
    }
  },
  onPathChanged: (path) => {
    // Saved or renamed: the session follows the file without a restart —
    // its variables stay, and relative paths resolve in the new folder.
    kernel.moveTo?.(fileManager.root, path);
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
    // editor, a rewind): replace in place and keep the session — restarting
    // on every external save would kill exploration state mid-thought —
    // and the place: the view, the scroll and the focused cell (place.ts).
    const restore = keepPlace($('doc'), $('sheet'));
    const source = docView.isSource;
    docView.setDoc(doc);
    if (source && !docView.isSource) docView.setSource(true);
    if (fileManager.dir || fileManager.root) docView.hydrateAll();
    restore();
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
    // (While uv builds the environment, as long as that takes.)
    for (let waited = 0; !opensViaShell && !kernel.isReady && (waited < 8000 || environmentSyncing); waited += 100) {
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

// A rewind in the shell's history view (shell.ts, answerRewinds): asked
// to save, the document is written through ⌘S's write (ok: false, with
// why, refuses the rewind: a document with no file, a write that failed)
// and the autosave holds until the rewind is over, so it cannot write back
// over the file being restored; told to reload a path that is this document's,
// it is re-read through the shell and replaced in place. The session is
// not rewound: its names stay, and every cell is stale.
if (shell) {
  answerRewinds(shell, {
    path: () => fileManager.path,
    save: () => fileManager.saveForRewind(),
    release: () => fileManager.release(),
    reload: async (rewound) => {
      const error = await fileManager.reloadFromDisk();
      docView.markAllStale();
      toast(error ? `${rewound}, but ${fileManager.name} could not be read: ${error}` : `${rewound}; the session is as it was, so every cell is stale`);
    },
  });
}

// File → Recent documents: the one inherently dynamic list, loaded each
// time it opens, in place of the File menu with a way back (Plass's Recent
// papers).
menu.back(recentMenu, 'File');
menu.heading(recentMenu, 'Recent documents');
const recentEntries = document.createElement('div');
recentEntries.setAttribute('role', 'group');
recentEntries.setAttribute('aria-label', 'Recent documents');
recentMenu.element.append(recentEntries);
let recentRequest = 0;
recentMenu.refresh = () => {
  const request = ++recentRequest;
  const hint = menu.hint(recentEntries, 'Loading recent documents…');
  hint.setAttribute('role', 'status');
  recentEntries.replaceChildren(hint);
  void fileManager.recents().then((entries) => {
    if (request !== recentRequest) return;
    if (!entries.length) {
      hint.textContent = 'Your saved documents will appear here.';
      return;
    }
    recentEntries.replaceChildren();
    for (const entry of entries) {
      menu.item(recentEntries, entry.name, () => void fileManager.openRecent(entry), { title: entry.path ?? entry.name });
    }
  }).catch(() => {
    if (request === recentRequest) hint.textContent = 'Recent documents could not be loaded.';
  });
};

$('view-toggle').addEventListener('click', () => docView.setSource(!docView.isSource));
$('add-code').addEventListener('click', () => docView.insertRelative('program'));
$('add-scratch').addEventListener('click', () => docView.insertRelative('scratch'));
$('add-text').addEventListener('click', () => docView.insertRelative('text'));
$('run-all').addEventListener('click', () => void docView.runAllProgram());
$('run-stale').addEventListener('click', () => void docView.runStale());
$('stop').addEventListener('click', () => kernel.interrupt());
$('restart').addEventListener('click', () => {
  void kernel.restart().then(() => {
    docView.markAllStale();
    session?.restarted();
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
    input.remove();
    repaintName(); // the label again, whether renamed or cancelled
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

// The service worker keeps the PWA's shell for a launch with no engine.
// Inside Knuth.app the shell starts the engine and serves the page, so it
// has no job there, and a cached page could only be a stale one.
if ('serviceWorker' in navigator && !shell) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((error) => {
      console.warn('Knuth service worker registration failed', error);
    });
  });
}
