// A Kernel backed by Pyodide, for the hosted preview where there is no local
// engine to talk to (SAME_ORIGIN.md). It is deliberately not a second
// implementation of Knuth's session semantics: it loads the same
// knuth.session and knuth.kernel modules the sidecar runs and drives the same
// `handle_request` dispatcher, so the two backends cannot drift on what a run
// returns, what a namespace snapshot contains, or where the limits are.
//
// Packages come in three tiers. What Pyodide ships (numpy, pandas, scipy,
// matplotlib, statsmodels, …) is fetched from the same base URL when a
// cell imports it. The document's own PEP 723 header (ENVIRONMENT.md) is
// honored first: its dependencies install before a cell runs, through the
// same knuth.env parser the engine uses, so one header names the
// packages in both modes. Pure-Python packages from PyPI (seaborn, plotly, …) are
// installed through micropip the same way: an import the tab cannot
// satisfy is tried on PyPI before the cell runs, and a `# %pip install x`
// or `# !pip install x` line — what the notebook importer leaves behind —
// names a package outright, for the cases where import name and package
// name differ. Anything with compiled code that nobody has built for
// WebAssembly is the wall; the cell then fails with a plain
// ModuleNotFoundError after a line saying why.
//
// What it cannot do is interrupt. Cancelling running Python needs a shared
// memory buffer and cross-origin isolation, which a static host does not
// offer; `interrupt()` reports that rather than pretending.

import type {
  Artifacts,
  ConvertResult,
  DocumentResult,
  FigureResult,
  Kernel,
  KernelListeners,
  KernelStatus,
  NamespaceVar,
  PersistedResult,
  RenamedResult,
  RunHandlers,
  RunOptions,
  RunOutcome,
  SavedResult,
  StatResult,
  TableWindow,
} from './kernel.ts';

import { pipDirectives } from './pip-lines.ts';

import initSource from '../../python/knuth/__init__.py?raw';
import artifactsSource from '../../python/knuth/artifacts.py?raw';
import contractSource from '../../python/knuth/contract.py?raw';
import envSource from '../../python/knuth/env.py?raw';
import ipynbSource from '../../python/knuth/ipynb.py?raw';
import limitsSource from '../../python/knuth/limits.py?raw';
import percentSource from '../../python/knuth/percent.py?raw';
import sessionSource from '../../python/knuth/session.py?raw';
import kernelSource from '../../python/knuth/kernel.py?raw';

const PYODIDE_VERSION = '0.28.3';
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

interface Micropip {
  install(requirement: string): Promise<void>;
}

interface PyodideApi {
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
  loadPackage(name: string): Promise<void>;
  loadPackagesFromImports(code: string): Promise<void>;
  pyimport(name: string): unknown;
  globals: { set(name: string, value: unknown): void };
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: string, opts?: { encoding: string }): void;
  };
}

type ServerEvent = Record<string, unknown> & { type: string; id?: number };

// The shim owns only what the browser changes: where events go, and the fact
// that there is no stdin. Everything else is imported.
const SHIM = `
import json, sys
import knuth.kernel as kernel_module
from knuth.kernel import Session, _StreamOut, handle_request

_state = {"id": None, "stream_bytes": 0}
_session = Session()

def _emit(event):
    _knuth_emit(json.dumps(event, ensure_ascii=False))

sys.stdout = _StreamOut(_emit, _state, "stdout")
sys.stderr = _StreamOut(_emit, _state, "stderr")

def knuth_handle(raw):
    msg = json.loads(raw)
    if msg.get("type") == "restart":
        global _session
        _session = Session()
        _emit({"type": "ready", "id": msg.get("id")})
        return
    handle_request(msg, _session, _state, _emit)

def knuth_reset():
    global _session
    _session = Session()

def knuth_missing_imports(code):
    # Top-level imports the tab cannot satisfy yet, after Pyodide's own
    # packages were loaded: candidates for PyPI. Stdlib and installed
    # packages resolve; a name that does not is either a PyPI package
    # under its import name, a mismatch (sklearn vs scikit-learn), or a
    # typo — micropip sorts those out, and the run reports the rest.
    import importlib.util
    from pyodide.code import find_imports
    missing = []
    for name in find_imports(code):
        try:
            found = importlib.util.find_spec(name) is not None
        except (ImportError, ValueError):
            found = False
        if not found and name not in missing:
            missing.append(name)
    return json.dumps(missing)

def knuth_header_requirements(text):
    # The document's declared dependencies, by the engine's own parser.
    from knuth.env import parse_header
    header = parse_header(text)
    if header is None:
        return json.dumps({"dependencies": []})
    return json.dumps({
        "dependencies": header.get("dependencies", []),
        "error": header.get("error"),
    })

async def knuth_install(requirement):
    # micropip's own words for a failure ("Can't find a pure Python 3
    # wheel for 'polars'") are the useful ones; an empty string is success.
    import micropip
    try:
        await micropip.install(requirement)
    except Exception as error:
        return str(error).strip().split("\\n")[0] or type(error).__name__
    return ""

def knuth_convert(raw):
    # The one converter (ipynb.py), the same call server.py makes.
    from knuth.ipynb import notebook_to_document
    from knuth.percent import serialize_document
    try:
        doc, commented = notebook_to_document(raw)
    except ValueError as error:
        return json.dumps({"error": str(error)})
    return json.dumps({"text": serialize_document(doc), "commented": commented})
`;

export class PyodideKernel implements Kernel {
  private pyodide: PyodideApi | null = null;
  private micropip: Micropip | null = null;
  /** Requirements already installed this session, and the preamble text
   *  they came from: a header is re-read only when it changes. */
  private installed = new Set<string>();
  private lastPreamble: string | null = null;
  private ready: Promise<void>;
  private closed = false;
  private booted = false;
  /** No engine, no folder: the page's file manager stays in handle mode. */
  readonly root: string | null = null;
  private nextId = 1;
  private runs = new Map<number, { handlers?: RunHandlers; resolve(o: RunOutcome): void }>();
  private waiters = new Map<number, (event: ServerEvent) => void>();

  constructor(
    private onStatus?: (status: KernelStatus, resumed?: boolean) => void,
    private listeners: KernelListeners = {},
  ) {
    this.onStatus?.('connecting');
    this.ready = this.boot().then(
      () => {
        this.booted = true;
        this.onStatus?.('ready', false);
      },
      (error) => {
        console.error('Pyodide failed to start', error);
        this.onStatus?.('kernel_failed');
      },
    );
  }

  private async boot(): Promise<void> {
    const { loadPyodide } = (await import(
      /* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`
    )) as { loadPyodide(opts: { indexURL: string }): Promise<PyodideApi> };
    const pyodide = await loadPyodide({ indexURL: PYODIDE_URL });

    pyodide.FS.mkdirTree('/lib/knuth');
    const files: Array<[string, string]> = [
      ['__init__.py', initSource],
      ['artifacts.py', artifactsSource],
      ['contract.py', contractSource],
      ['env.py', envSource],
      ['ipynb.py', ipynbSource],
      ['limits.py', limitsSource],
      ['percent.py', percentSource],
      ['session.py', sessionSource],
      ['kernel.py', kernelSource],
    ];
    for (const [name, source] of files) {
      pyodide.FS.writeFile(`/lib/knuth/${name}`, source, { encoding: 'utf8' });
    }
    pyodide.runPython('import sys; sys.path.insert(0, "/lib")');
    pyodide.globals.set('_knuth_emit', (raw: string) => this.receive(raw));
    pyodide.runPython(SHIM);
    try {
      await pyodide.loadPackage('micropip');
      this.micropip = pyodide.pyimport('micropip') as Micropip;
    } catch (error) {
      // Without micropip the shipped packages still work; only PyPI is off.
      console.warn('micropip is unavailable; PyPI packages cannot be installed', error);
    }
    this.pyodide = pyodide;
  }

  /** Make a cell's imports importable before it runs: Pyodide's own
   *  packages first, then PyPI for whatever is still missing, plus any
   *  packages named on pip lines. Failures are reported on the cell's
   *  stderr and the cell still runs, so the import error that follows is
   *  the real one. */
  private async providePackages(code: string, id: number, handlers?: RunHandlers): Promise<void> {
    const py = this.pyodide!;
    try {
      await py.loadPackagesFromImports(code);
    } catch (error) {
      console.warn('Could not preload packages for this cell', error);
    }
    if (!this.micropip) return;
    // Named packages first: a pip line exists to say which package an
    // import name comes from, so the scan below must see it installed.
    for (const requirement of pipDirectives(code)) await this.micropipInstall(requirement, id);
    let missing: string[] = [];
    try {
      py.globals.set('_knuth_code', code);
      missing = JSON.parse(String(py.runPython('knuth_missing_imports(_knuth_code)'))) as string[];
    } catch (error) {
      console.warn('Could not inspect imports', error);
    }
    for (const name of missing) await this.micropipInstall(name, id);
  }

  /** The document's declared dependencies (its PEP 723 header), installed
   *  before anything else: the header is the source of truth in both
   *  modes, and a name it declares may not match any import. */
  private async provideHeader(preamble: string, id: number, handlers?: RunHandlers): Promise<void> {
    if (!this.micropip || preamble === this.lastPreamble) return;
    this.lastPreamble = preamble;
    const py = this.pyodide!;
    let parsed: { dependencies?: string[]; error?: string | null };
    try {
      py.globals.set('_knuth_preamble', preamble);
      parsed = JSON.parse(String(py.runPython('knuth_header_requirements(_knuth_preamble)')));
    } catch (error) {
      console.warn('Could not read the document header', error);
      return;
    }
    if (parsed.error) handlers?.onStream?.('stderr', `${parsed.error}\n`);
    for (const requirement of parsed.dependencies ?? []) await this.micropipInstall(requirement, id);
  }

  /** One requirement through micropip, reported as the engine reports
   *  its own installs: dependency events for the page to toast, nothing
   *  on the cell's stream, so receipts never carry an "Installing" line
   *  that a run under real Python would not produce. */
  private async micropipInstall(requirement: string, id: number): Promise<void> {
    if (this.installed.has(requirement)) return;
    const py = this.pyodide!;
    const module = requirement.split(/[<>=!~\[; ]/)[0];
    this.listeners.onDependency?.({ id, state: 'installing', module, distribution: requirement });
    let reason: string;
    try {
      py.globals.set('_knuth_requirement', requirement);
      reason = String(await py.runPythonAsync('await knuth_install(_knuth_requirement)'));
    } catch (error) {
      reason = String((error as { message?: string })?.message || error);
    }
    if (!reason) {
      this.installed.add(requirement);
      this.listeners.onDependency?.({ id, state: 'installed', module, distribution: requirement });
      return;
    }
    this.listeners.onDependency?.({
      id,
      state: 'failed',
      module,
      distribution: requirement,
      error: `${reason} (packages with compiled code need Python installed on this computer)`,
    });
  }

  get isReady(): boolean {
    return this.booted && !this.closed;
  }

  private receive(raw: string): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    const id = typeof event.id === 'number' ? event.id : null;
    if (event.type === 'stream' && id !== null) {
      this.runs.get(id)?.handlers?.onStream?.(
        event.which as 'stdout' | 'stderr',
        String(event.text ?? ''),
      );
      return;
    }
    if (event.type === 'figures' && id !== null) {
      this.runs.get(id)?.handlers?.onFigures?.(
        (event.svgs as string[]) ?? [],
        (event.named as string[]) ?? [],
      );
      return;
    }
    if (event.type === 'done' && id !== null) {
      this.runs.get(id)?.resolve({
        ok: true,
        result: (event.result as string | null) ?? null,
        traceback: null,
      });
      this.runs.delete(id);
      return;
    }
    if (event.type === 'error' && id !== null) {
      this.runs.get(id)?.resolve({
        ok: false,
        result: null,
        traceback: String(event.traceback ?? 'error'),
      });
      this.runs.delete(id);
      return;
    }
    if (id !== null && this.waiters.has(id)) {
      this.waiters.get(id)!(event);
      this.waiters.delete(id);
    }
  }

  private async send(msg: Record<string, unknown>): Promise<void> {
    await this.ready;
    if (this.closed || !this.pyodide) return;
    const py = this.pyodide;
    py.globals.set('_knuth_request', JSON.stringify(msg));
    await py.runPythonAsync('knuth_handle(_knuth_request)');
  }

  private async ask<T>(
    msg: Record<string, unknown>,
    read: (event: ServerEvent) => T,
    fallback: T,
  ): Promise<T> {
    await this.ready;
    if (this.closed || !this.pyodide) return fallback;
    const id = this.nextId++;
    return new Promise<T>((resolve) => {
      this.waiters.set(id, (event) =>
        resolve(event.type === 'protocol_error' ? fallback : read(event)),
      );
      void this.send({ ...msg, id }).catch(() => {
        this.waiters.delete(id);
        resolve(fallback);
      });
    });
  }

  async run(code: string, handlers?: RunHandlers, opts?: RunOptions): Promise<RunOutcome> {
    await this.ready;
    if (this.closed || !this.pyodide) {
      return { ok: false, result: null, traceback: 'Python is not running' };
    }
    // The header first, then the cell's imports: together they are what
    // makes `import pandas` — or `import seaborn` — work in a tab with
    // nothing installed.
    const id = this.nextId++;
    if (opts?.preamble !== undefined) await this.provideHeader(opts.preamble, id, handlers);
    await this.providePackages(code, id, handlers);
    return new Promise<RunOutcome>((resolve) => {
      this.runs.set(id, { handlers, resolve });
      void this.send({ type: 'run', id, code, scratch: opts?.scratch ?? false }).catch(
        (error: unknown) => {
          this.runs.delete(id);
          resolve({ ok: false, result: null, traceback: String(error) });
        },
      );
    });
  }

  interrupt(): void {
    // Interrupting Python from the page needs SharedArrayBuffer and
    // cross-origin isolation, which a static host cannot provide. Saying so
    // beats a button that silently does nothing.
    console.warn('Interrupt is not available in the browser preview.');
  }

  async restart(_root?: string | null, _document?: string | null): Promise<void> {
    await this.ready;
    if (this.closed || !this.pyodide) return;
    this.lastPreamble = null;
    const id = this.nextId++;
    await new Promise<void>((resolve) => {
      this.waiters.set(id, () => resolve());
      void this.send({ type: 'restart', id }).catch(() => resolve());
    });
    this.onStatus?.('ready', false);
  }

  namespace(): Promise<NamespaceVar[]> {
    return this.ask(
      { type: 'namespace' },
      (event) => (event.vars as NamespaceVar[]) ?? [],
      [] as NamespaceVar[],
    );
  }

  artifacts(): Promise<Artifacts | null> {
    return this.ask(
      { type: 'artifacts' },
      (event) => ({
        values: (event.values as Record<string, unknown>) ?? {},
        figures: (event.figures as Record<string, string>) ?? {},
      }),
      null as Artifacts | null,
    );
  }

  table(name: string, offset = 0, limit = 100): Promise<TableWindow | null> {
    return this.ask(
      { type: 'table', name, offset, limit },
      (event) => event as unknown as TableWindow,
      null as TableWindow | null,
    );
  }

  figure(name: string): Promise<FigureResult | null> {
    return this.ask(
      { type: 'figure', name },
      (event) => event as unknown as FigureResult,
      null as FigureResult | null,
    );
  }

  async convert(text: string): Promise<ConvertResult | null> {
    await this.ready;
    if (this.closed || !this.pyodide) return null;
    this.pyodide.globals.set('_knuth_notebook', text);
    try {
      const raw = await this.pyodide.runPythonAsync('knuth_convert(_knuth_notebook)');
      return JSON.parse(String(raw)) as ConvertResult;
    } catch (error) {
      return { error: String(error) };
    }
  }

  // Documents by path are the engine's job; in the tab there is no engine
  // and no folder, so these answer as a missing engine would and the file
  // manager keeps using browser handles.
  async openPath(_path: string): Promise<DocumentResult | null> {
    return null;
  }

  async savePath(_path: string, _text: string): Promise<SavedResult | null> {
    return null;
  }

  async statPath(_path: string): Promise<StatResult | null> {
    return null;
  }

  async renamePath(_path: string, _name: string): Promise<RenamedResult | null> {
    return null;
  }

  async persist(): Promise<PersistedResult | null> {
    return null;
  }

  close(): void {
    this.closed = true;
  }
}
