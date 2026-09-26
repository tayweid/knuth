// A Kernel that is still loading. The preview's backend arrives over the
// network, so the app has to have something to hold before it does — every
// call queues behind the real one rather than the boot being special-cased
// through the rest of the app.

import type {
  Artifacts,
  ConvertResult,
  DocumentResult,
  FigureResult,
  Kernel,
  KernelStatus,
  NamespaceVar,
  PersistedResult,
  RenamedResult,
  RunHandlers,
  RunOutcome,
  SavedResult,
  StatResult,
  TableWindow,
} from './kernel.ts';

export class LazyKernel implements Kernel {
  private closed = false;
  private arrived: Kernel | null = null;

  constructor(
    private pending: Promise<Kernel>,
    onStatus?: (status: KernelStatus, resumed?: boolean) => void,
  ) {
    onStatus?.('connecting');
    void pending.then(
      (kernel) => { this.arrived = kernel; },
      () => onStatus?.('kernel_failed'),
    );
  }

  get isReady(): boolean {
    return !this.closed && (this.arrived?.isReady ?? false);
  }

  get root(): string | null {
    return this.arrived?.root ?? null;
  }

  private async real(): Promise<Kernel | null> {
    try {
      const kernel = await this.pending;
      return this.closed ? null : kernel;
    } catch {
      return null;
    }
  }

  async run(code: string, handlers?: RunHandlers, opts?: { scratch?: boolean }): Promise<RunOutcome> {
    const kernel = await this.real();
    if (!kernel) return { ok: false, result: null, traceback: 'Python is not running' };
    return kernel.run(code, handlers, opts);
  }

  interrupt(): void {
    void this.real().then((kernel) => kernel?.interrupt());
  }

  async restart(root?: string | null, document?: string | null): Promise<void> {
    await (await this.real())?.restart(root, document);
  }

  async namespace(): Promise<NamespaceVar[]> {
    return (await (await this.real())?.namespace()) ?? [];
  }

  async artifacts(): Promise<Artifacts | null> {
    return (await (await this.real())?.artifacts()) ?? null;
  }

  async table(name: string, offset?: number, limit?: number): Promise<TableWindow | null> {
    return (await (await this.real())?.table(name, offset, limit)) ?? null;
  }

  async figure(name: string): Promise<FigureResult | null> {
    return (await (await this.real())?.figure(name)) ?? null;
  }

  async convert(text: string): Promise<ConvertResult | null> {
    return (await (await this.real())?.convert(text)) ?? null;
  }

  async openPath(path: string): Promise<DocumentResult | null> {
    return (await (await this.real())?.openPath(path)) ?? null;
  }

  async savePath(path: string, text: string): Promise<SavedResult | null> {
    return (await (await this.real())?.savePath(path, text)) ?? null;
  }

  async statPath(path: string): Promise<StatResult | null> {
    return (await (await this.real())?.statPath(path)) ?? null;
  }

  async renamePath(path: string, name: string): Promise<RenamedResult | null> {
    return (await (await this.real())?.renamePath(path, name)) ?? null;
  }

  async persist(): Promise<PersistedResult | null> {
    return (await (await this.real())?.persist()) ?? null;
  }

  close(): void {
    this.closed = true;
    void this.real().then((kernel) => kernel?.close());
  }
}
