// The grid: a .csv/.tsv file as a table of cells, each one editable in
// place. Deliberately a viewer with a pen, not a spreadsheet — no
// formulas, sorting, resizing, or column operations. The grid owns the
// file's physical lines while it is on screen and rewrites only the
// lines of the row a cell belongs to (src/format/csv.ts), so a cell edit
// is a one-line diff; the document view reparses the lines after each
// change and marks the file dirty.
//
// Keys: arrows move, Enter/F2 (or typing) edits, Enter commits and moves
// down (past the last row: appends one), Tab commits and moves right,
// Escape reverts, Backspace/Delete clears — and on a row that is already
// entirely empty, removes it.

import { type CsvRow, emptyRow, rowValues, setValue, splitRows } from './format/csv.ts';

const PAGE_SIZE = 1000;

export interface GridOptions {
  delimiter: string;
  /** The file's physical lines. The grid edits this array in place. */
  lines: string[];
  /** The lines changed (a cell committed, a row added or removed). */
  onChange(lines: string[]): void;
}

export class GridView {
  readonly root: HTMLElement;
  private table: HTMLTableElement;
  private tbody: HTMLTableSectionElement;
  private rows: CsvRow[];
  private cols: number;
  private pageStart = 0;
  private pager: HTMLElement;
  /** The cell being typed into, with its value before the edit. */
  private editing: { td: HTMLTableCellElement; before: string } | null = null;

  constructor(private opts: GridOptions) {
    this.rows = splitRows(opts.lines, opts.delimiter);
    // An empty file still offers a cell to type into.
    if (this.rows.length === 0) this.rows.push(emptyRow(undefined, 0));
    this.cols = this.rows.reduce((n, row) => Math.max(n, row.raws.length), 1);

    this.root = document.createElement('div');
    this.root.className = 'grid-scroll';
    this.table = document.createElement('table');
    this.table.className = 'grid';
    this.tbody = document.createElement('tbody');
    this.pager = document.createElement('nav');
    this.pager.className = 'grid-pager';
    this.pager.setAttribute('aria-label', 'CSV pages');
    this.table.append(this.tbody);
    this.root.append(this.pager, this.table);
    this.renderPage();

    this.table.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.table.addEventListener('dblclick', (e) => {
      const td = this.cellOf(e.target);
      if (td && !this.editing) this.startEdit(td);
    });
    this.table.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.table.addEventListener('focusout', (e) => {
      // Leaving the cell commits it — unless focus is only moving to
      // another cell we are about to handle ourselves.
      if (this.editing && e.target === this.editing.td) this.commit();
    });
  }

  focus() {
    this.cellAt(0, 0)?.focus();
  }

  destroy() {
    this.root.remove();
  }

  // ---------- rendering ----------

  private renderPage() {
    this.pageStart = Math.min(this.pageStart, Math.floor((this.rows.length - 1) / PAGE_SIZE) * PAGE_SIZE);
    const end = Math.min(this.pageStart + PAGE_SIZE, this.rows.length);
    this.tbody.replaceChildren();
    for (let r = this.pageStart; r < end; r++) this.tbody.append(this.buildRow(r, this.rows[r]));
    this.pager.replaceChildren();
    this.pager.hidden = this.rows.length <= PAGE_SIZE;
    const label = document.createElement('span');
    label.textContent = `Rows ${this.pageStart + 1}–${end} of ${this.rows.length}`;
    const button = (text: string, start: number, disabled: boolean) => {
      const el = document.createElement('button');
      el.textContent = text;
      el.disabled = disabled;
      el.addEventListener('click', () => {
        this.commit();
        this.pageStart = start;
        this.renderPage();
        this.root.scrollTop = 0;
        this.cellAt(this.pageStart, 0)?.focus();
      });
      return el;
    };
    this.pager.append(
      button('Previous', this.pageStart - PAGE_SIZE, this.pageStart === 0),
      label,
      button('Next', this.pageStart + PAGE_SIZE, end === this.rows.length),
    );
  }

  private buildRow(index: number, row: CsvRow): HTMLTableRowElement {
    const tr = document.createElement('tr');
    const num = document.createElement('th');
    num.className = 'rn';
    num.textContent = String(index + 1);
    tr.append(num);
    const values = rowValues(row);
    for (let c = 0; c < this.cols; c++) {
      const td = document.createElement('td');
      td.tabIndex = -1;
      td.textContent = values[c] ?? '';
      tr.append(td);
    }
    return tr;
  }

  // ---------- addressing ----------

  private cellOf(target: EventTarget | null): HTMLTableCellElement | null {
    if (!(target instanceof Element)) return null;
    const td = target.closest('td');
    return td instanceof HTMLTableCellElement && this.table.contains(td) ? td : null;
  }

  private cellAt(r: number, c: number): HTMLTableCellElement | null {
    const tr = this.tbody.rows[r - this.pageStart];
    if (!tr) return null;
    const td = tr.cells[c + 1];
    return td instanceof HTMLTableCellElement && td.tagName === 'TD' ? td : null;
  }

  private position(td: HTMLTableCellElement): { r: number; c: number } {
    const tr = td.parentElement as HTMLTableRowElement;
    return { r: this.pageStart + tr.sectionRowIndex, c: td.cellIndex - 1 };
  }

  // ---------- events ----------

  private onMouseDown(e: MouseEvent) {
    const td = this.cellOf(e.target);
    if (!td) return;
    if (this.editing?.td === td) return; // placing the caret within the edit
    if (this.editing) this.commit();
    // Focus the cell as a cell (not a text field) — a double click edits.
    e.preventDefault();
    td.focus();
  }

  private onKeyDown(e: KeyboardEvent) {
    const td = this.cellOf(e.target);
    if (!td) return;
    if (this.editing) {
      this.onEditKey(e, td);
      return;
    }
    const { r, c } = this.position(td);
    switch (e.key) {
      case 'ArrowUp':
        this.move(r - 1, c, e);
        return;
      case 'ArrowDown':
        this.move(r + 1, c, e);
        return;
      case 'ArrowLeft':
        this.move(r, c - 1, e);
        return;
      case 'ArrowRight':
        this.move(r, c + 1, e);
        return;
      case 'Tab':
        if (this.move(r, e.shiftKey ? c - 1 : c + 1, e)) return;
        // Off the row's end: wrap to the next (or previous) row.
        this.move(e.shiftKey ? r - 1 : r + 1, e.shiftKey ? this.cols - 1 : 0, e);
        return;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        this.startEdit(td);
        return;
      case 'Backspace':
      case 'Delete':
        e.preventDefault();
        if (td.textContent !== '') this.write(td, '');
        else if (this.rowIsEmpty(r)) this.removeRow(r, c);
        return;
      default:
        break;
    }
    // A printable key starts typing into an emptied cell, as in a sheet.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.startEdit(td, '');
    }
  }

  private onEditKey(e: KeyboardEvent, td: HTMLTableCellElement) {
    const { r, c } = this.position(td);
    switch (e.key) {
      case 'Enter': {
        e.preventDefault();
        this.commit();
        // Past the last row, Enter makes a new one: the way rows are added.
        if (r + 1 >= this.rows.length) this.appendRow();
        this.move(r + 1, c);
        return;
      }
      case 'Tab':
        e.preventDefault();
        this.commit();
        if (!this.move(r, e.shiftKey ? c - 1 : c + 1)) {
          this.move(e.shiftKey ? r - 1 : r + 1, e.shiftKey ? this.cols - 1 : 0);
        }
        return;
      case 'Escape':
        e.preventDefault();
        this.revert();
        return;
      default:
        return;
    }
  }

  /** Focus the cell at (r, c) if there is one; true when there was. */
  private move(r: number, c: number, e?: KeyboardEvent): boolean {
    if (r < 0 || r >= this.rows.length || c < 0 || c >= this.cols) return false;
    if (r < this.pageStart || r >= this.pageStart + PAGE_SIZE) {
      this.pageStart = Math.floor(r / PAGE_SIZE) * PAGE_SIZE;
      this.renderPage();
    }
    const td = this.cellAt(r, c);
    if (!td) return false;
    e?.preventDefault();
    td.focus();
    td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }

  // ---------- editing ----------

  private startEdit(td: HTMLTableCellElement, initial?: string) {
    const before = td.textContent ?? '';
    this.editing = { td, before };
    if (initial !== undefined) td.textContent = initial;
    td.classList.add('editing');
    td.contentEditable = 'plaintext-only';
    td.focus();
    // Caret at the end: editing appends unless the user moves it.
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(td);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  private stopEdit(): HTMLTableCellElement | null {
    const edit = this.editing;
    if (!edit) return null;
    this.editing = null;
    edit.td.contentEditable = 'false';
    edit.td.classList.remove('editing');
    return edit.td;
  }

  private commit() {
    const before = this.editing?.before;
    const td = this.stopEdit();
    if (!td) return;
    const value = td.textContent ?? '';
    if (value !== before) this.write(td, value);
  }

  private revert() {
    const before = this.editing?.before ?? '';
    const td = this.stopEdit();
    if (!td) return;
    td.textContent = before;
    td.focus();
  }

  /** Put a value in a cell: the row's own lines rewritten, nothing else. */
  private write(td: HTMLTableCellElement, value: string) {
    const { r, c } = this.position(td);
    const row = this.rows[r];
    const fresh = setValue(row, c, value, this.opts.delimiter);
    this.opts.lines.splice(row.start, row.count, ...fresh);
    const delta = fresh.length - row.count;
    row.count = fresh.length;
    for (let i = r + 1; i < this.rows.length; i++) this.rows[i].start += delta;
    td.textContent = value;
    this.opts.onChange(this.opts.lines);
  }

  private rowIsEmpty(r: number): boolean {
    return this.rows[r].raws.every((raw) => raw === '');
  }

  private appendRow() {
    const last = this.rows[this.rows.length - 1];
    // The placeholder row of an empty file is not a line yet; make it
    // one, so the new row lands after it rather than on it.
    if (this.opts.lines.length === 0) this.opts.lines.push('');
    const row = emptyRow(last, this.opts.lines.length);
    this.rows.push(row);
    this.opts.lines.push(row.eol);
    this.renderPage();
    this.opts.onChange(this.opts.lines);
  }

  private removeRow(r: number, c: number) {
    // The last row standing stays: a grid always has a cell to type in.
    if (this.rows.length === 1) return;
    const row = this.rows[r];
    this.rows.splice(r, 1);
    this.opts.lines.splice(row.start, row.count);
    for (let i = r; i < this.rows.length; i++) this.rows[i].start -= row.count;
    this.renderPage();
    this.opts.onChange(this.opts.lines);
    this.move(Math.min(r, this.rows.length - 1), c);
  }
}
