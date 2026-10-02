// The data and figure viewers (RStudio-quality half of the architecture),
// moved from the old side panel (panel.ts) into the Session card's Data
// and Figures tabs (session.ts): they look into the LIVE session
// namespace, not the document. Tabular variables (DataFrame, Series,
// 2-D ndarray) open in the data viewer; data arrives in windows of 100
// rows and the full object never leaves the kernel. Figures render
// through safe-svg (sanitized, an inert image), by name from the kernel
// or, for a run's unnamed figure, from the SVG the run drew.

import type { Kernel, NamespaceVar, TableWindow } from './kernel/kernel.ts';
import { clearSafeSvgImages, createSafeSvgImage } from './safe-svg.ts';

const PAGE = 100;

export function isTabular(v: NamespaceVar): boolean {
  return (
    v.type === 'DataFrame' ||
    v.type === 'Series' ||
    (v.type === 'ndarray' && v.shape?.length === 2)
  );
}

export function shapeLabel(v: NamespaceVar): string {
  if (v.shape) return v.shape.join('×');
  if (v.length !== undefined) return String(v.length);
  return '';
}

/** One viewer in one element: the Data tab's (a table, paging) or the
 *  Figures tab's (a figure). `onClose` is told when its ✕ closes it. */
export class Viewer {
  private current: { name: string; rows: number; total: number } | null = null;
  private currentFigure: string | null = null;

  constructor(
    private viewer: HTMLElement,
    private kernel: Kernel,
    private onClose?: () => void,
  ) {
    viewer.classList.add('viewer');
    viewer.hidden = true;
  }

  /** What is open: a table or a named figure, by name. */
  get showing(): string | null {
    return this.current?.name ?? this.currentFigure;
  }

  /** The namespace moved (a run): refresh (or close) the open view — a
   *  rebound table re-reads its first page, a name gone closes it. */
  async refresh(vars: NamespaceVar[]): Promise<void> {
    if (this.current) {
      const still = vars.find((v) => v.name === this.current!.name && isTabular(v));
      if (still) await this.open(this.current.name);
      else this.closeViewer();
    } else if (this.currentFigure) {
      const still = vars.find((v) => v.name === this.currentFigure && v.figure);
      if (still) await this.openFigure(this.currentFigure);
      else this.closeViewer();
    }
  }

  /** A run's own figures, as it drew them (the receipt's SVGs): for a
   *  figure no name holds, which the kernel cannot render again. */
  showDrawn(svgs: string[], label: string): void {
    this.current = null;
    this.currentFigure = null;
    clearSafeSvgImages(this.viewer);
    const head = document.createElement('div');
    head.className = 'pane-title viewer-head';
    const title = document.createElement('span');
    title.textContent = label;
    head.append(title);
    const scroller = document.createElement('div');
    scroller.className = 'viewer-scroll';
    for (const svg of svgs) {
      const image = createSafeSvgImage(svg, label);
      if (!image) continue;
      const card = document.createElement('div');
      card.className = 'figure';
      card.append(image);
      scroller.append(card);
    }
    this.viewer.hidden = false;
    this.viewer.append(head, scroller);
  }

  close(): void {
    this.closeViewer();
  }

  /** RStudio-style plot pane: the figure behind a named variable. */
  async openFigure(name: string): Promise<void> {
    const result = await this.kernel.figure(name);
    if (!result || result.error || !result.svg) {
      this.closeViewer();
      return;
    }
    const image = createSafeSvgImage(result.svg, name);
    if (!image) {
      this.closeViewer();
      return;
    }
    this.current = null;
    this.currentFigure = name;
    this.viewer.hidden = false;
    clearSafeSvgImages(this.viewer);

    const head = document.createElement('div');
    head.className = 'pane-title viewer-head';
    const title = document.createElement('span');
    title.textContent = name;
    const close = document.createElement('button');
    close.textContent = '✕';
    close.title = 'Close viewer';
    close.addEventListener('click', () => this.closeViewer(true));
    head.append(title, close);

    const scroller = document.createElement('div');
    scroller.className = 'viewer-scroll';
    const card = document.createElement('div');
    card.className = 'figure';
    card.append(image);
    scroller.append(card);

    this.viewer.append(head, scroller);
  }

  async open(name: string): Promise<void> {
    const window = await this.kernel.table(name, 0, PAGE);
    if (!window || window.error) {
      this.closeViewer();
      return;
    }
    this.currentFigure = null;
    this.current = { name, rows: window.rows!.length, total: window.total_rows! };
    this.renderViewer(window, false);
  }

  private async more(): Promise<void> {
    if (!this.current) return;
    const window = await this.kernel.table(this.current.name, this.current.rows, PAGE);
    if (!window || window.error || !window.rows?.length) return;
    this.current.rows += window.rows.length;
    this.renderViewer(window, true);
  }

  private renderViewer(window: TableWindow, append: boolean): void {
    this.viewer.hidden = false;
    let scroller: HTMLElement;
    if (!append) {
      clearSafeSvgImages(this.viewer);

      const head = document.createElement('div');
      head.className = 'pane-title viewer-head';
      const title = document.createElement('span');
      const colNote =
        window.total_cols! > window.columns!.length
          ? ` (${window.columns!.length} of ${window.total_cols} cols)`
          : '';
      title.textContent = `${window.name} — ${window.total_rows}×${window.total_cols}${colNote}`;
      const close = document.createElement('button');
      close.textContent = '✕';
      close.title = 'Close viewer';
      close.addEventListener('click', () => this.closeViewer(true));
      head.append(title, close);

      scroller = document.createElement('div');
      scroller.className = 'viewer-scroll';
      const table = document.createElement('table');
      table.className = 'data-table';
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      hr.append(document.createElement('th')); // index corner
      for (const c of window.columns!) {
        const th = document.createElement('th');
        th.textContent = c;
        hr.append(th);
      }
      thead.append(hr);
      const tbody = document.createElement('tbody');
      table.append(thead, tbody);
      scroller.append(table);

      const foot = document.createElement('div');
      foot.className = 'viewer-foot';
      this.viewer.append(head, scroller, foot);
    } else {
      scroller = this.viewer.querySelector<HTMLElement>('.viewer-scroll')!;
    }

    const tbody = scroller.querySelector('tbody')!;
    window.rows!.forEach((row, i) => {
      const tr = document.createElement('tr');
      const idx = document.createElement('th');
      idx.textContent = window.index![i];
      tr.append(idx);
      for (const cellText of row) {
        const td = document.createElement('td');
        td.textContent = cellText;
        tr.append(td);
      }
      tbody.append(tr);
    });

    const foot = this.viewer.querySelector<HTMLElement>('.viewer-foot')!;
    foot.textContent = '';
    if (this.current && this.current.rows < this.current.total) {
      const more = document.createElement('button');
      more.textContent = `More (${this.current.rows} of ${this.current.total} rows)`;
      more.addEventListener('click', () => void this.more());
      foot.append(more);
    } else if (this.current) {
      foot.textContent = `${this.current.total} rows`;
    }
  }

  private closeViewer(asked = false): void {
    this.current = null;
    this.currentFigure = null;
    this.viewer.hidden = true;
    clearSafeSvgImages(this.viewer);
    if (asked) this.onClose?.();
  }
}
