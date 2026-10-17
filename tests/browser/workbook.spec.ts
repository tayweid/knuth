import { expect, test, type Page } from '@playwright/test';

// An Excel workbook, by path: the engine reads one sheet at a time as CSV
// text (python/knuth/workbook.py) and the page shows it as a read-only
// grid with the sheets as tabs. The fake engine below answers `open` with
// a sheet the way files.py does and records every request, so a test can
// say that nothing was ever written.

type Probe = Window & { __knuthMessages?: Array<Record<string, unknown>> };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const probe = window as Probe;
    probe.__knuthMessages = [];
    const sheets: Record<string, string> = {
      Grades: 'Name,Score\nAda,93.5\n"Bob, Jr.",88\n',
      Notes: ',\n,only cell\n',
    };
    class MockWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.dispatchEvent(new Event('open'));
        });
      }

      send(raw: string) {
        const msg = JSON.parse(raw) as Record<string, unknown>;
        probe.__knuthMessages!.push(msg);
        switch (msg.type) {
          case 'attach':
            this.reply({ type: 'attached', protocol: msg.protocol, session: msg.session, resumed: false, root: msg.root ?? null });
            this.reply({ type: 'ready' });
            break;
          case 'restart':
            this.reply({ type: 'ready', id: msg.id });
            break;
          case 'open': {
            const sheet = typeof msg.sheet === 'string' && msg.sheet in sheets ? msg.sheet : 'Grades';
            const text = sheets[sheet];
            this.reply({
              type: 'document',
              id: msg.id,
              path: msg.path,
              name: String(msg.path).split('/').pop(),
              text,
              modified: 1000,
              workbook: { sheets: Object.keys(sheets), sheet, rows: text.split('\n').length - 1, truncated: false },
            });
            break;
          }
          case 'stat':
            this.reply({ type: 'stat', id: msg.id, path: msg.path, modified: 1000 });
            break;
          case 'save':
            this.reply({ type: 'saved', id: msg.id, error: 'grades.xlsx is an Excel workbook, which Knuth only reads' });
            break;
        }
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close'));
      }

      private reply(message: object) {
        window.setTimeout(() => {
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
        });
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
});

async function sent(page: Page, type: string) {
  return page.evaluate((type) => (window as Probe).__knuthMessages!.filter((m) => m.type === type), type);
}

test('a workbook opens as a read-only grid of its first sheet', async ({ page }) => {
  await page.goto('/?open=/p/grades.xlsx');
  await expect(page).toHaveTitle('grades.xlsx');
  const grid = page.locator('table.grid');
  await expect(grid).toHaveClass(/read-only/);
  await expect(grid.locator('tr')).toHaveCount(3);
  await expect(grid.locator('tr').nth(2).locator('td')).toHaveText(['Bob, Jr.', '88']);
  await expect(page.locator('#toast')).toContainText('read-only');
  expect(await sent(page, 'open')).toEqual([{ type: 'open', id: expect.any(Number), path: '/p/grades.xlsx' }]);

  // Nothing types, clears, adds or removes: the arrows still move.
  const cell = grid.locator('tr').nth(1).locator('td').nth(0);
  await cell.dblclick();
  await expect(cell).not.toHaveClass(/editing/);
  await cell.click();
  await page.keyboard.type('Eve');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Backspace');
  await expect(cell).toHaveText('Ada');
  await page.keyboard.press('ArrowDown');
  await expect(grid.locator('tr').nth(2).locator('td').nth(0)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(grid.locator('tr')).toHaveCount(3);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(grid.locator('tr').nth(2).locator('td')).toHaveText(['Bob, Jr.', '88']);

  // Shown, so saved: the dot stays green, and nothing was written.
  await expect(page.locator('#doc-pod')).toHaveClass(/doc-saved/);
  expect(await sent(page, 'save')).toEqual([]);

  // There is no source to switch to: the switch rests, the shortcut too.
  await expect(page.locator('#view-toggle')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('ControlOrMeta+Shift+e');
  await expect(page.locator('body')).toHaveAttribute('data-view', 'grid');
});

test('the sheets are tabs, each read when it is picked', async ({ page }) => {
  await page.goto('/?open=/p/grades.xlsx');
  const tabs = page.getByRole('navigation', { name: 'Sheets' }).getByRole('button');
  await expect(tabs).toHaveText(['Grades', 'Notes']);
  await expect(tabs.nth(0)).toHaveAttribute('aria-current', 'true');

  await tabs.nth(1).click();
  const grid = page.locator('table.grid');
  await expect(grid.locator('tr').nth(1).locator('td')).toHaveText(['', 'only cell']);
  await expect(grid).toHaveClass(/read-only/);
  await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'true');
  expect((await sent(page, 'open')).map((m) => m.sheet)).toEqual([undefined, 'Notes']);
  // Another sheet is the same document: the session carries on.
  expect(await sent(page, 'restart')).toEqual([]);

  // A reload restores the sheet, still read-only, with its tabs.
  await page.reload();
  await expect(page.locator('table.grid')).toHaveClass(/read-only/);
  await expect(page.locator('table.grid tr').nth(1).locator('td')).toHaveText(['', 'only cell']);
  await expect(tabs.nth(1)).toHaveAttribute('aria-current', 'true');
});

test('⌘S saves the sheet on screen as CSV, never the workbook', async ({ page }) => {
  await page.goto('/?open=/p/grades.xlsx');
  await expect(page.locator('table.grid')).toHaveClass(/read-only/);
  // Read-only: no Save in the pill; ⌘S writes the sheet as CSV.
  await expect(page.locator('#doc-save')).toBeHidden();

  await page.getByRole('navigation', { name: 'Sheets' }).getByRole('button', { name: 'Notes' }).click();
  await expect(page.locator('table.grid tr').nth(1).locator('td')).toHaveText(['', 'only cell']);
  // No save panel in a browser tab: the CSV arrives as a download.
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('ControlOrMeta+s')]);
  expect(download.suggestedFilename()).toBe('grades - Notes.csv');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks).toString('utf8')).toBe(',\n,only cell\n');
  expect(await sent(page, 'save')).toEqual([]);
});
