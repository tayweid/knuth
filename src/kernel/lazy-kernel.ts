// A Kernel that is still loading. The preview's backend arrives over the
// network, so the app has to have something to hold before it does — every
// call queues behind the real one rather than the boot being special-cased
// through the rest of the app.

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

export class LazyKernel implements Kernel {
  private closed = false;

  constructor(
    private pending: Promise<Kernel>,
    onStatus?: (status: KernelStatus, resumed?: boolean) => void,
  ) {
    onStatus?.('connecting');
    void pending.catch(() => onStatus?.('kernel_failed'));
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

  async restart(): Promise<void> {
    await (await this.real())?.restart();
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

  close(): void {
    this.closed = true;
    void this.real().then((kernel) => kernel?.close());
  }
}
