// Export to Markdown (export.ts, main.ts exportMarkdown): the document as
// Plass reads it, code hidden, written beside the document. A fake engine
// keeps a little disk, runs cells (a cell that plots draws a figure), and
// answers the table a cell ends by showing.
import { expect, test, type Page } from '@playwright/test';

type Probe = typeof window & { __disk?: Record<string, string>; __sent?: Array<Record<string, unknown>> };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#36c"/></svg>';
const DOC = [
  '# %% [markdown]', '# # Report', '#', '# Prices fell as $q$ rose.', '',
  '# %%', 'prices = load()', 'prices', '',
  '# %%', 'ax = prices.plot()', '',
  '# %% scratch', '#| tmp = 1', '',
  '# %% [markdown]', '# The end.', '',
].join('\n');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ doc, svg }) => {
    const probe = window as Probe;
    probe.__disk = { '/p/report.py': doc };
    probe.__sent = [];
    class MockWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = 0;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
        window.setTimeout(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event('open'));
        });
      }
      send(raw: string) {
        const msg = JSON.parse(raw) as Record<string, unknown>;
        probe.__sent!.push(msg);
        const disk = probe.__disk!;
        const path = String(msg.path ?? '');
        switch (msg.type) {
          case 'attach':
            this.reply({ type: 'attached', protocol: msg.protocol, session: msg.session, resumed: false, root: msg.root ?? null });
            this.reply({ type: 'ready' });
            break;
          case 'restart':
            this.reply({ type: 'ready', id: msg.id });
            break;
          case 'open':
            this.reply(disk[path] === undefined
              ? { type: 'document', id: msg.id, error: 'no such file' }
              : { type: 'document', id: msg.id, path, name: path.split('/').pop(), text: disk[path], modified: 1000 });
            break;
          case 'save':
            disk[path] = String(msg.text);
            this.reply({ type: 'saved', id: msg.id, path, modified: 2000 });
            break;
          case 'stat':
            this.reply({ type: 'stat', id: msg.id, path, modified: disk[path] === undefined ? null : 2000 });
            break;
          case 'run':
            if (String(msg.code).includes('plot')) this.reply({ type: 'figures', id: msg.id, svgs: [svg], named: ['ax'] });
            this.reply({ type: 'done', id: msg.id, result: null });
            break;
          case 'namespace':
            this.reply({ type: 'namespace', id: msg.id, vars: [] });
            break;
          case 'table':
            this.reply(msg.name === 'prices'
              ? { type: 'table', id: msg.id, name: 'prices', columns: ['price', 'q'], index: ['0', '1'], rows: [['0.5', '812'], ['1.0', '410']], total_rows: 250, total_cols: 2, offset: 0 }
              : { type: 'table', id: msg.id, name: msg.name, error: 'not a table' });
            break;
          default:
            if (typeof msg.id === 'number') this.reply({ type: 'done', id: msg.id, result: null });
        }
      }
      close() {
        this.readyState = 3;
        this.dispatchEvent(new CloseEvent('close'));
      }
      private reply(message: object) {
        window.setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  }, { doc: DOC, svg: SVG });
});

const disk = (page: Page) => page.evaluate(() => (window as Probe).__disk!);
const saves = (page: Page) => page.evaluate(() => (window as Probe).__sent!.filter((m) => m.type === 'save').map((m) => m.path));

async function boot(page: Page) {
  await page.goto('/?open=/p/report.py');
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(page.locator('#file-name')).toHaveText('report.py');
}

test('Export writes the document beside it as Markdown for Plass: title, text, the table shown, the figure, and no code', async ({ page }) => {
  await boot(page);
  const tile = page.locator('#export-tile');
  await expect(tile).toHaveAttribute('title', /Markdown for Plass/);
  await page.locator('#run-all').click();
  await expect(page.locator('#sheet .cell-figures img')).toHaveCount(1);
  await tile.click();
  await expect(page.locator('#toast')).toContainText('Exported report.md beside report.py: open it in Plass to make the PDF.');
  const md = (await disk(page))['/p/report.md'];
  expect(md.startsWith('---\ntitle: "Report"\n---\n\nPrices fell as $q$ rose.\n\n|  | price | q |\n| :-- | --: | --: |\n| 0 | 0.5 | 812 |\n| 1 | 1.0 | 410 |\n\n*The first 2 of 250 rows.*\n\n![](data:image/svg+xml;base64,')).toBe(true);
  expect(md.endsWith(')\n\nThe end.\n')).toBe(true);
  for (const code of ['load()', 'plot()', 'tmp']) expect(md).not.toContain(code);
  // The document itself is untouched and still the window's.
  expect((await disk(page))['/p/report.py']).toBe(DOC);
  await expect(page.locator('#file-name')).toHaveText('report.py');
});

test('Export never writes over a Markdown file that is there unless asked: Replace does', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Probe).__disk!['/p/report.md'] = 'edited in Plass\n';
  });
  await boot(page);
  await page.locator('#export-tile').click();
  await expect(page.locator('#toast')).toContainText('report.md is already there');
  expect(await saves(page)).not.toContain('/p/report.md');
  expect((await disk(page))['/p/report.md']).toBe('edited in Plass\n');
  await page.locator('#toast button', { hasText: 'Replace' }).click();
  await expect(page.locator('#toast')).toContainText('Exported report.md');
  expect((await disk(page))['/p/report.md']).toContain('title: "Report"');
});
