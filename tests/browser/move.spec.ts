import { expect, test, type Page } from '@playwright/test';

// Moving cells (document-view.ts, moveCell and startDrag): a cell is
// dragged by the grip in the margin left of its row, a blue line marks
// where it will land, and the file follows. The engine is the trimmed mock
// text-cell.spec.ts uses: nothing here runs.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
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
        const msg = JSON.parse(raw);
        if (msg.type === 'attach') {
          this.reply({ type: 'attached', protocol: msg.protocol, session: msg.session, resumed: false });
          this.reply({ type: 'ready' });
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

const DOC = [
  '# %% [markdown]', '# # Moving cells', '',
  '# %%', 'a = 1', '',
  '# %%', 'b = a + 1', '',
  '# %% [markdown]', '# A note at the end.', '',
  '# %%', 'c = b * 2', '',
].join('\n');

async function boot(page: Page) {
  await page.addInitScript((text) => {
    sessionStorage.setItem('knuth-doc', JSON.stringify({ name: 'move.py', dirty: false, text }));
  }, DOC);
  await page.setViewportSize({ width: 1100, height: 820 });
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');
}

const rows = (page: Page) => page.locator('#sheet .cell-wrap > .cell');
const firstLines = (page: Page) => rows(page).evaluateAll((all) => all.map((row) => (row.querySelector('.cm-line, .ProseMirror > *')?.textContent ?? '').trim()));
const saved = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('knuth-doc')!).text as string);

/** Drag cell `from` by its grip to `y` (the viewport), and let go unless
 *  `hold`. */
async function drag(page: Page, from: number, y: number, hold = false) {
  const row = rows(page).nth(from);
  await row.hover();
  const grip = row.locator('.cell-grip');
  await expect(grip).toBeVisible();
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + 40, y, { steps: 8 });
  if (!hold) await page.mouse.up();
}

test('a cell is dragged by its grip: a line marks the gap, and the file follows the new order', async ({ page }) => {
  await boot(page);
  expect(await firstLines(page)).toEqual(['Moving cells', 'a = 1', 'b = a + 1', 'A note at the end.', 'c = b * 2']);
  // The grip shows under the pointer only, in the margin left of the row.
  const grip = rows(page).nth(2).locator('.cell-grip');
  await page.mouse.move(900, 780);
  await expect.poll(() => grip.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
  await rows(page).nth(2).hover();
  await expect.poll(() => grip.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
  expect((await grip.boundingBox())!.x + 13).toBeLessThanOrEqual((await rows(page).nth(2).boundingBox())!.x + 0.5);
  // Held over the top of "a = 1": the cell fades, a label rides with the
  // pointer, the line sits in the gap above "a = 1".
  const a = (await rows(page).nth(1).boundingBox())!;
  await drag(page, 2, a.y + 4, true);
  await expect(rows(page).nth(2)).toHaveClass(/drag-source/);
  await expect(page.locator('.drag-ghost')).toContainText('b = a + 1');
  const line = (await page.locator('.drop-line').boundingBox())!;
  expect(line.y).toBeLessThan(a.y);
  expect(line.y).toBeGreaterThan(a.y - 24);
  await page.mouse.up();
  await expect(page.locator('.drop-line, .drag-ghost')).toHaveCount(0);
  expect(await firstLines(page)).toEqual(['Moving cells', 'b = a + 1', 'a = 1', 'A note at the end.', 'c = b * 2']);
  await expect(rows(page).nth(1)).toHaveClass(/just-moved/);
  // The file: the cells in their new order, each still followed by its
  // blank line.
  await expect.poll(() => saved(page)).toBe([
    '# %% [markdown]', '# # Moving cells', '',
    '# %%', 'b = a + 1', '',
    '# %%', 'a = 1', '',
    '# %% [markdown]', '# A note at the end.', '',
    '# %%', 'c = b * 2', '',
  ].join('\n'));
});

test('the last cell moved up keeps a blank line after it; a code cell\'s move stales from where it moved; ⌘Z puts it back', async ({ page }) => {
  await boot(page);
  const stale = () => page.evaluate(() => document.body.dataset.stale);
  const before = await stale();
  // A text cell moved stales nothing.
  const top = (await rows(page).nth(1).boundingBox())!;
  await drag(page, 3, top.y + 4);
  expect(await firstLines(page)).toEqual(['Moving cells', 'A note at the end.', 'a = 1', 'b = a + 1', 'c = b * 2']);
  expect(await stale()).toBe(before);
  // The last code cell to the top of the code: every code cell from there
  // down is stale, as after an edit there.
  const a = (await rows(page).nth(2).boundingBox())!;
  await drag(page, 4, a.y + 4);
  expect(await firstLines(page)).toEqual(['Moving cells', 'A note at the end.', 'c = b * 2', 'a = 1', 'b = a + 1']);
  for (const i of [2, 3, 4]) await expect(rows(page).nth(i)).toHaveClass(/stale/);
  await expect.poll(() => saved(page)).toContain('# %%\nc = b * 2\n\n# %%\na = 1');
  // ⌘Z puts it back where it was.
  await page.mouse.move(900, 780);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await firstLines(page)).toEqual(['Moving cells', 'A note at the end.', 'a = 1', 'b = a + 1', 'c = b * 2']);
});

test('Esc, or letting go where it started, leaves the cell where it was', async ({ page }) => {
  await boot(page);
  const order = await firstLines(page);
  const end = (await rows(page).nth(4).boundingBox())!;
  await drag(page, 1, end.y + end.height + 8, true);
  await expect(page.locator('.drop-line')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.drop-line, .drag-ghost')).toHaveCount(0);
  await page.mouse.up();
  expect(await firstLines(page)).toEqual(order);
  // Over its own place: no line, no move.
  const self = (await rows(page).nth(1).boundingBox())!;
  await drag(page, 1, self.y + self.height / 2 - 2, true);
  await expect(page.locator('.drop-line')).toBeHidden();
  await page.mouse.up();
  expect(await firstLines(page)).toEqual(order);
  await expect(rows(page).nth(1)).not.toHaveClass(/just-moved/);
});
