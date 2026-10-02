// The engine events the other specs' mocks never answer (ROADMAP.md, test
// debt): an attach the engine refuses as incompatible, a run interrupted
// from the toolbar, and a DataFrame opened in the data viewer. Each once,
// so a reshape of these messages on the server side is noticed here.
import { expect, test } from '@playwright/test';

type Probe = Window & {
  __knuthIncompatible?: boolean;
  __knuthInterrupted?: boolean;
  __knuthTableRequests?: Array<Record<string, unknown>>;
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class MockWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      private running: number | null = null;

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
        const probe = window as Probe;
        if (msg.type === 'attach') {
          if (probe.__knuthIncompatible) {
            // What server.py sends to a page whose protocol is not its
            // own, then it closes the socket.
            this.reply({ type: 'incompatible', protocol: msg.protocol + 1, received: msg.protocol });
            window.setTimeout(() => this.close(1002), 20);
            return;
          }
          this.reply({ type: 'attached', protocol: msg.protocol, session: msg.session, resumed: false });
          this.reply({ type: 'ready' });
        } else if (msg.type === 'run') {
          // A run that never finishes by itself: only an interrupt ends it.
          this.running = msg.id;
          this.reply({ type: 'stream', id: msg.id, which: 'stdout', text: 'working…\n' });
        } else if (msg.type === 'interrupt') {
          probe.__knuthInterrupted = true;
          if (this.running !== null) {
            this.reply({ type: 'error', id: this.running, traceback: 'KeyboardInterrupt' });
            this.running = null;
          }
        } else if (msg.type === 'namespace') {
          this.reply({
            type: 'namespace',
            id: msg.id,
            vars: [{ name: 'df', type: 'DataFrame', shape: [2, 2], preview: '<DataFrame 2×2>' }],
          });
        } else if (msg.type === 'table') {
          (probe.__knuthTableRequests ??= []).push(msg);
          this.reply({
            type: 'table',
            id: msg.id,
            name: msg.name,
            columns: ['wage', 'hours'],
            index: ['0', '1'],
            rows: [['12.5', '40'], ['19.0', '32']],
            total_rows: 2,
            total_cols: 2,
            offset: msg.offset,
          });
        } else if (msg.type === 'artifacts') {
          this.reply({ type: 'artifacts', id: msg.id, values: {}, figures: {} });
        }
      }

      close(code = 1000) {
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close', { code }));
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

test('an engine that refuses the protocol is reported as incompatible, not down', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Probe).__knuthIncompatible = true;
  });
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('kernel/app versions do not match');
  await expect(page.getByRole('heading', { name: 'Update the local Python engine' })).toBeVisible();
});

test('Stop interrupts the running cell, which ends in the interrupt', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await page.locator('.cell .run').first().click();
  const output = page.locator('.cell .output').first();
  await expect(output).toContainText('working…');
  await page.locator('#stop').click();
  await expect.poll(() => page.evaluate(() => (window as Probe).__knuthInterrupted === true)).toBe(true);
  await expect(output).toContainText('KeyboardInterrupt');
});

test('a DataFrame opens in the data viewer as a page of rows', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  // The Session card drops from the pill; a table's name opens the Data tab.
  await page.locator('#session-pill').click();
  const row = page.locator('#session .s-row', { hasText: 'df' });
  await expect(row).toBeVisible();
  await row.click();
  const table = page.locator('.data-table');
  await expect(table).toBeVisible();
  await expect(table.locator('th', { hasText: 'wage' })).toBeVisible();
  await expect(table.locator('td', { hasText: '19.0' })).toBeVisible();
  const requests = await page.evaluate(() => (window as Probe).__knuthTableRequests ?? []);
  expect(requests[0]).toMatchObject({ type: 'table', name: 'df', offset: 0 });
});
