// A Kernel backed by Pyodide, for the hosted preview where there is no local
// engine to talk to (SAME_ORIGIN.md). It is deliberately not a second
// implementation of Knuth's session semantics: it loads the same
// knuth.session and knuth.kernel modules the sidecar runs and drives the same
// `handle_request` dispatcher, so the two backends cannot drift on what a run
// returns, what a namespace snapshot contains, or where the limits are.
//
// What it cannot do is interrupt. Cancelling running Python needs a shared
// memory buffer and cross-origin isolation, which a static host does not
// offer; `interrupt()` reports that rather than pretending.

import type {
  Artifacts,
  FigureResult,
  Kernel,
  KernelStatus,
  NamespaceVar,
  RunHandlers,
  RunOutcome,
  TableWindow,
} from './kernel.ts';

import initSource from '../../python/knuth/__init__.py?raw';
import artifactsSource from '../../python/knuth/artifacts.py?raw';
import limitsSource from '../../python/knuth/limits.py?raw';
import sessionSource from '../../python/knuth/session.py?raw';
import kernelSource from '../../python/knuth/kernel.py?raw';

const PYODIDE_VERSION = '0.28.3';
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

interface PyodideApi {
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
  loadPackagesFromImports(code: string): Promise<void>;
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
`;

export class PyodideKernel implements Kernel {
  private pyodide: PyodideApi | null = null;
  private ready: Promise<void>;
  private closed = false;
  private nextId = 1;
  private runs = new Map<number, { handlers?: RunHandlers; resolve(o: RunOutcome): void }>();
  private waiters = new Map<number, (event: ServerEvent) => void>();

  constructor(private onStatus?: (status: KernelStatus, resumed?: boolean) => void) {
    this.onStatus?.('connecting');
    this.ready = this.boot().then(
      () => this.onStatus?.('ready', false),
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
      ['limits.py', limitsSource],
      ['session.py', sessionSource],
      ['kernel.py', kernelSource],
    ];
    for (const [name, source] of files) {
      pyodide.FS.writeFile(`/lib/knuth/${name}`, source, { encoding: 'utf8' });
    }
    pyodide.runPython('import sys; sys.path.insert(0, "/lib")');
    pyodide.globals.set('_knuth_emit', (raw: string) => this.receive(raw));
    pyodide.runPython(SHIM);
    this.pyodide = pyodide;
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

  async run(code: string, handlers?: RunHandlers, opts?: { scratch?: boolean }): Promise<RunOutcome> {
    await this.ready;
    if (this.closed || !this.pyodide) {
      return { ok: false, result: null, traceback: 'Python is not running' };
    }
    // Imports decide which packages are needed; loading them here is what
    // makes `import pandas` work in a tab with nothing installed.
    try {
      await this.pyodide.loadPackagesFromImports(code);
    } catch (error) {
      console.warn('Could not preload packages for this cell', error);
    }
    const id = this.nextId++;
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

  async restart(): Promise<void> {
    await this.ready;
    if (this.closed || !this.pyodide) return;
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

  close(): void {
    this.closed = true;
  }
}
