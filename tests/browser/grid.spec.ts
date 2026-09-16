import { expect, test } from '@playwright/test';

// A trimmed mock of app.spec.ts's engine socket: these tests only need the
// app to reach "kernel" status, never to run a cell.
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

function seed(page: import('@playwright/test').Page, name: string, text: string) {
  return page.addInitScript(
    ({ name, text }) => {
      sessionStorage.setItem('knuth-doc', JSON.stringify({ name, dirty: false, text }));
    },
    { name, text },
  );
}

/** The document as the app would save it (the session stash, written
 *  shortly after every change). */
async function stashedText(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('knuth-doc') ?? '{}').text);
}

const CSV = 'name,age\nada,36\ngrace,45\n';
test('large CSVs open in a bounded grid and edit the correct row across pages', async ({ page }) => {
  const text = Array.from({ length: 40001 }, (_, i) => `${i},value`).join('\n') + '\n';
  await seed(page, 'large.csv', text);
  await page.goto('/');
  const rows = page.locator('table.grid tr');
  await expect(rows).toHaveCount(1000);
  await expect(page.locator('.grid-pager')).toContainText('Rows 1–1000 of 40001');
  await rows.last().locator('td').first().click();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.grid-pager')).toContainText('Rows 1001–2000 of 40001');
  await expect(rows.first().locator('td').first()).toBeFocused();
  await page.keyboard.type('changed');
  await page.keyboard.press('Tab');
  const expected = text.replace('1000,value\n', 'changed,value\n');
  await expect.poll(() => stashedText(page)).toBe(expected);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(rows.first().locator('td').first()).toHaveText('2000');
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(rows.first().locator('td').first()).toHaveText('changed');
  await page.locator('#view-toggle').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'source');
  await page.locator('#view-toggle').click();
  await expect(rows).toHaveCount(1000);
});

test('undo restores exact CSV text, redo reapplies it, and new edits discard redo', async ({ page }) => {
  await seed(page, 'fussy.csv', FUSSY);
  await page.goto('/');
  const cell = page.locator('table.grid tr').nth(1).locator('td').nth(0);
  await cell.click();
  await page.keyboard.type('Ada');
  await page.keyboard.press('Tab');
  const edited = FUSSY.replace('Lovelace, Ada', 'Ada');
  await expect.poll(() => stashedText(page)).toBe(edited);
  await page.locator('#view-toggle').click();
  await page.locator('#view-toggle').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => stashedText(page)).toBe(FUSSY);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => stashedText(page)).toBe(edited);
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.type('New');
  // Undo while still typing reverses the whole current cell edit.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(cell).toHaveText('Lovelace, Ada');
  await page.keyboard.type('Other');
  await page.keyboard.press('Tab');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => stashedText(page)).toBe(FUSSY.replace('Lovelace, Ada', 'Other'));
});

test('row insertion and deletion can be undone and redone', async ({ page }) => {
  await seed(page, 'rows.csv', CSV);
  await page.goto('/');
  const rows = page.locator('table.grid tr');
  await rows.last().locator('td').first().click();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(4);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(rows).toHaveCount(3);
  await expect.poll(() => stashedText(page)).toBe(CSV);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(rows).toHaveCount(4);
  await page.keyboard.press('Backspace');
  await expect(rows).toHaveCount(3);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(rows).toHaveCount(4);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => stashedText(page)).toBe(CSV);
});
// CRLF, a BOM, and a quoted field: the conventions an edit must keep.
const FUSSY = '\uFEFFname,note\r\n"Lovelace, Ada","said ""hi"""\r\ngrace,x\r\n';

test('a .csv opens as a grid of its cells', async ({ page }) => {
  await seed(page, 'people.csv', CSV);
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('kernel');

  const grid = page.locator('table.grid');
  await expect(grid).toBeVisible();
  await expect(grid.locator('tr')).toHaveCount(3);
  await expect(grid.locator('tr').nth(0).locator('td')).toHaveText(['name', 'age']);
  await expect(grid.locator('tr').nth(1).locator('td')).toHaveText(['ada', '36']);
  await expect(page.locator('body')).toHaveAttribute('data-view', 'grid');
  // The workbench chrome is away; the toggle offers the source view.
  await expect(page.locator('#toolbar')).toBeHidden();
  await expect(page.locator('#view-toggle')).toBeVisible();
  await expect(page.locator('#view-toggle')).toHaveText(/Source/);
});

test('editing a cell rewrites its line and nothing else', async ({ page }) => {
  await seed(page, 'people.csv', CSV);
  await page.goto('/');
  await expect(page.locator('table.grid')).toBeVisible();

  const cell = page.locator('table.grid tr').nth(1).locator('td').nth(1);
  await cell.dblclick();
  await expect(cell).toHaveClass(/editing/);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('37');
  await page.keyboard.press('Enter');
  await expect(cell).toHaveText('37');
  await expect(cell).not.toHaveClass(/editing/);
  // Enter committed and moved down.
  await expect(page.locator('table.grid tr').nth(2).locator('td').nth(1)).toBeFocused();
  await expect.poll(() => stashedText(page)).toBe('name,age\nada,37\ngrace,45\n');
  // Marked dirty (the dot lives in the toolbar, which the grid view hides).
  await expect(page.locator('.dirty')).toHaveCount(1);
});

test('typing into a focused cell replaces it; Escape reverts', async ({ page }) => {
  await seed(page, 'people.csv', CSV);
  await page.goto('/');
  await expect(page.locator('table.grid')).toBeVisible();

  const cell = page.locator('table.grid tr').nth(2).locator('td').nth(0);
  await cell.click();
  await expect(cell).toBeFocused();
  await page.keyboard.type('hopper');
  await expect(cell).toHaveText('hopper');
  await page.keyboard.press('Escape');
  await expect(cell).toHaveText('grace');
  await page.keyboard.type('h');
  await page.keyboard.press('Tab');
  await expect(cell).toHaveText('h');
  await expect(page.locator('table.grid tr').nth(2).locator('td').nth(1)).toBeFocused();
  await expect.poll(() => stashedText(page)).toBe('name,age\nada,36\nh,45\n');
});

test('an edit keeps CRLF, the BOM, and the quoting of the rest', async ({ page }) => {
  await seed(page, 'fussy.csv', FUSSY);
  await page.goto('/');
  const grid = page.locator('table.grid');
  await expect(grid).toBeVisible();
  await expect(grid.locator('tr').nth(0).locator('td')).toHaveText(['name', 'note']);
  await expect(grid.locator('tr').nth(1).locator('td')).toHaveText(['Lovelace, Ada', 'said "hi"']);

  const cell = grid.locator('tr').nth(2).locator('td').nth(1);
  await cell.click();
  await page.keyboard.type('y, z');
  await page.keyboard.press('Tab');
  await expect.poll(() => stashedText(page)).toBe(
    '\uFEFFname,note\r\n"Lovelace, Ada","said ""hi"""\r\ngrace,"y, z"\r\n',
  );
});

test('Enter past the last row adds one; Backspace on an empty row removes it', async ({ page }) => {
  await seed(page, 'people.csv', CSV);
  await page.goto('/');
  const grid = page.locator('table.grid');
  await expect(grid).toBeVisible();

  const last = grid.locator('tr').nth(2).locator('td').nth(0);
  await last.click();
  await page.keyboard.press('Enter'); // edit
  await page.keyboard.press('Enter'); // commit (unchanged) and move past the end
  await expect(grid.locator('tr')).toHaveCount(4);
  const added = grid.locator('tr').nth(3).locator('td').nth(0);
  await expect(added).toBeFocused();
  await page.keyboard.type('linus');
  await page.keyboard.press('Tab');
  await page.keyboard.type('4');
  await page.keyboard.press('Tab');
  await expect.poll(() => stashedText(page)).toBe('name,age\nada,36\ngrace,45\nlinus,4\n');

  // Clear the new row cell by cell, then one more Backspace removes it.
  await added.click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Backspace');
  await expect.poll(() => stashedText(page)).toBe('name,age\nada,36\ngrace,45\n,\n');
  await page.keyboard.press('Backspace');
  await expect(grid.locator('tr')).toHaveCount(3);
  await expect.poll(() => stashedText(page)).toBe('name,age\nada,36\ngrace,45\n');
});

test('the toggle flips to the source editor and back, same lines', async ({ page }) => {
  await seed(page, 'people.csv', CSV);
  await page.goto('/');
  await expect(page.locator('table.grid')).toBeVisible();

  await page.locator('#view-toggle').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'source');
  await expect(page.locator('table.grid')).toHaveCount(0);
  const editor = page.locator('.cm-content');
  await expect(editor).toContainText('ada,36');
  await expect(page.locator('#view-toggle')).toHaveText(/Grid/);

  // Edit in source, and the grid shows it.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('linus,4');
  await page.keyboard.press('ControlOrMeta+Shift+e');
  const grid = page.locator('table.grid');
  await expect(grid).toBeVisible();
  await expect(grid.locator('tr')).toHaveCount(4);
  await expect(grid.locator('tr').nth(3).locator('td')).toHaveText(['linus', '4']);
});

test('a .tsv splits on tabs; a .txt gets no grid', async ({ page }) => {
  await seed(page, 'people.tsv', 'name\tcity\nada\tLondon, UK\n');
  await page.goto('/');
  const grid = page.locator('table.grid');
  await expect(grid).toBeVisible();
  await expect(grid.locator('tr').nth(1).locator('td')).toHaveText(['ada', 'London, UK']);

  await seed(page, 'notes.txt', 'a,b\n1,2\n');
  await page.goto('/');
  await expect(page.locator('.cm-content')).toContainText('a,b');
  await expect(page.locator('table.grid')).toHaveCount(0);
  await expect(page.locator('#view-toggle')).toBeHidden();
});
