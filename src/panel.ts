// The session panes (RStudio-quality half of the architecture): a
// variable explorer and a data viewer that look into the LIVE session
// namespace, not the document. Tabular variables (DataFrame, Series,
// 2-D ndarray) open in the viewer; data arrives in windows of 100 rows
// and the full object never leaves the kernel.

import type { Kernel, NamespaceVar, TableWindow } from './kernel/kernel.ts';

const PAGE = 100;

function isTabular(v: NamespaceVar): boolean {
  return (
    v.type === 'DataFrame' ||
    v.type === 'Series' ||
    (v.type === 'ndarray' && v.shape?.length === 2)
  );
}

function shapeLabel(v: NamespaceVar): string {
  if (v.shape) return v.shape.join('×');
  if (v.length !== undefined) return String(v.length);
  return '';
}

export class SessionPanel {
  private varsBody: HTMLElement;
  private viewer: HTMLElement;
  private current: { name: string; rows: number; total: number } | null = null;

  constructor(
    private root: HTMLElement,
    private kernel: Kernel,
  ) {
    root.innerHTML = `
      <div class="pane vars">
        <div class="pane-title">Session</div>
        <table class="vars-table"><tbody></tbody></table>
        <div class="pane-empty" hidden>nothing in the session yet</div>
      </div>
      <div class="pane viewer" hidden></div>
    `;
    this.varsBody = root.querySelector('.vars-table tbody')!;
    this.viewer = root.querySelector<HTMLElement>('.pane.viewer')!;
  }

  /** Re-read the namespace; refresh (or close) the open data view. */
  async refresh(): Promise<void> {
    const vars = await this.kernel.namespace();
    this.varsBody.textContent = '';
    this.root.querySelector<HTMLElement>('.pane-empty')!.hidden = vars.length > 0;

    for (const v of vars) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.className = 'v-name';
      name.textContent = v.name;
      const type = document.createElement('td');
      type.className = 'v-type';
      type.textContent = v.type + (shapeLabel(v) ? ` ${shapeLabel(v)}` : '');
      const preview = document.createElement('td');
      preview.className = 'v-preview';
      preview.textContent = v.preview;
      tr.append(name, type, preview);
      if (isTabular(v)) {
        tr.className = 'viewable';
        tr.title = 'Open in the data viewer';
        tr.addEventListener('click', () => void this.open(v.name));
      }
      this.varsBody.append(tr);
    }

    if (this.current) {
      const still = vars.find((v) => v.name === this.current!.name && isTabular(v));
      if (still) await this.open(this.current.name);
      else this.closeViewer();
    }
  }

  async open(name: string): Promise<void> {
    const window = await this.kernel.table(name, 0, PAGE);
    if (!window || window.error) {
      this.closeViewer();
      return;
    }
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
      this.viewer.textContent = '';

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
      close.addEventListener('click', () => this.closeViewer());
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

  private closeViewer(): void {
    this.current = null;
    this.viewer.hidden = true;
    this.viewer.textContent = '';
  }
}
