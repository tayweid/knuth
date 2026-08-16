import { expect, test } from '@playwright/test';

const FIGURE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">
  <rect width="240" height="120" fill="#f7f4ed"/>
  <path d="M20 100 L80 55 L140 75 L220 20" fill="none" stroke="#336699" stroke-width="4"/>
</svg>`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript((figureSvg) => {
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
          this.reply({
            type: 'attached',
            protocol: msg.protocol,
            session: msg.session,
            resumed: false,
          });
          this.reply({ type: 'ready' });
        } else if (msg.type === 'namespace') {
          this.reply({
            type: 'namespace',
            vars: [
              {
                name: 'chart',
                type: 'Figure',
                preview: '<Figure size 240x120>',
                figure: true,
              },
            ],
          });
        } else if (msg.type === 'figure') {
          this.reply({ type: 'figure', name: msg.name, svg: figureSvg });
        }
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close'));
      }

      private reply(message: object) {
        window.setTimeout(() => {
          this.dispatchEvent(
            new MessageEvent('message', { data: JSON.stringify(message) }),
          );
        });
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: MockWebSocket,
    });
  }, FIGURE_SVG);
});

test('boots against the kernel protocol and renders a normal figure', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('#kernel-status')).toHaveText('kernel');
  const chart = page.getByText('chart', { exact: true });
  await expect(chart).toBeVisible();
  await chart.click();

  const figure = page.locator('.viewer .figure svg');
  await expect(figure).toBeVisible();
  await expect(figure.locator('path')).toHaveAttribute('stroke', '#336699');
});
