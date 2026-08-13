// The Kernel interface (KERNEL.md): everything the app needs from an
// execution backend. SidecarKernel is the v1 implementation; a Pyodide
// backend would implement the same surface.

export type StreamWhich = 'stdout' | 'stderr';

export interface RunHandlers {
  onStream?(which: StreamWhich, text: string): void;
}

export interface RunOutcome {
  ok: boolean;
  /** repr of the cell's last expression (null if none) when ok. */
  result: string | null;
  /** Formatted traceback when not ok. */
  traceback: string | null;
}

export interface NamespaceVar {
  name: string;
  type: string;
  shape?: number[];
  length?: number;
  preview: string;
}

export interface Kernel {
  ready: Promise<void>;
  run(code: string, handlers?: RunHandlers): Promise<RunOutcome>;
  interrupt(): void;
  restart(): Promise<void>;
  namespace(): Promise<NamespaceVar[]>;
  close(): void;
}

export const DEFAULT_KERNEL_URL = 'ws://127.0.0.1:5197';

interface PendingRun {
  handlers?: RunHandlers;
  resolve(outcome: RunOutcome): void;
}

export class SidecarKernel implements Kernel {
  ready: Promise<void>;
  private ws: WebSocket;
  private nextId = 1;
  private runs = new Map<number, PendingRun>();
  private namespaceWaiters: Array<(vars: NamespaceVar[]) => void> = [];
  private restartWaiters: Array<() => void> = [];
  private sawReady = false;

  constructor(url: string = DEFAULT_KERNEL_URL) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('error', () => reject(new Error(`kernel not reachable at ${url}`)), {
        once: true,
      });
      const onReady = () => {
        this.sawReady = true;
        resolve();
      };
      this.ws.addEventListener('message', (ev) => this.dispatch(JSON.parse(ev.data), onReady));
    });
  }

  private dispatch(msg: any, onFirstReady: () => void): void {
    switch (msg.type) {
      case 'ready': {
        if (!this.sawReady) {
          onFirstReady();
        } else {
          // Restart completed: in-flight runs will never finish.
          for (const run of this.runs.values()) {
            run.resolve({ ok: false, result: null, traceback: 'kernel restarted' });
          }
          this.runs.clear();
        }
        for (const resolve of this.restartWaiters.splice(0)) resolve();
        break;
      }
      case 'stream': {
        this.runs.get(msg.id)?.handlers?.onStream?.(msg.which, msg.text);
        break;
      }
      case 'done': {
        this.runs.get(msg.id)?.resolve({ ok: true, result: msg.result, traceback: null });
        this.runs.delete(msg.id);
        break;
      }
      case 'error': {
        this.runs.get(msg.id)?.resolve({ ok: false, result: null, traceback: msg.traceback });
        this.runs.delete(msg.id);
        break;
      }
      case 'namespace': {
        this.namespaceWaiters.shift()?.(msg.vars);
        break;
      }
    }
  }

  private send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }

  async run(code: string, handlers?: RunHandlers): Promise<RunOutcome> {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.runs.set(id, { handlers, resolve });
      this.send({ type: 'run', id, code });
    });
  }

  interrupt(): void {
    this.send({ type: 'interrupt' });
  }

  async restart(): Promise<void> {
    await this.ready;
    return new Promise((resolve) => {
      this.restartWaiters.push(resolve);
      this.send({ type: 'restart' });
    });
  }

  async namespace(): Promise<NamespaceVar[]> {
    await this.ready;
    return new Promise((resolve) => {
      this.namespaceWaiters.push(resolve);
      this.send({ type: 'namespace' });
    });
  }

  close(): void {
    this.ws.close();
  }
}
