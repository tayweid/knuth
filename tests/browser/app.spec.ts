import { expect, test } from '@playwright/test';

const FIGURE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">
  <rect width="240" height="120" fill="#f7f4ed"/>
  <path d="M20 100 L80 55 L140 75 L220 20" fill="none" stroke="#336699" stroke-width="4"/>
</svg>`;
const TEST_CAPABILITY = 'browser-test-capability-that-is-long-enough-to-use';
const MALICIOUS_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="240" height="120" onload="window.__knuthSvgExecuted = 'onload'">
  <script>window.__knuthSvgExecuted = 'script'</script>
  <foreignObject width="100" height="50">
    <img xmlns="http://www.w3.org/1999/xhtml" src="x"
         onerror="window.__knuthSvgExecuted = 'onerror'"/>
  </foreignObject>
  <style>@import url(https://attacker.example/import.css);</style>
  <image href="https://attacker.example/pixel.png" width="10" height="10"/>
  <a xlink:href="javascript:window.__knuthSvgExecuted='link'">
    <rect width="20" height="20"/>
  </a>
  <rect id="safe-mark" x="20" y="20" width="180" height="80"
        style="fill:url(https://attacker.example/fill.svg#paint)"/>
</svg>`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ figureSvg, capability }) => {
    localStorage.setItem('knuth-agent-capability', capability);

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
          if (msg.capability !== capability) {
            this.reply({ type: 'unauthorized' });
            window.setTimeout(() => this.close());
            return;
          }
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
          const testWindow = window as typeof window & { __knuthTestFigureSvg?: string };
          this.reply({
            type: 'figure',
            name: msg.name,
            svg: testWindow.__knuthTestFigureSvg ?? figureSvg,
          });
        } else if (msg.type === 'run') {
          const output = (
            window as typeof window & { __knuthTestRunOutput?: string }
          ).__knuthTestRunOutput;
          if (output) {
            this.reply({ type: 'stream', id: msg.id, which: 'stdout', text: output });
          }
          this.reply({ type: 'done', id: msg.id, result: null });
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
  }, { figureSvg: FIGURE_SVG, capability: TEST_CAPABILITY });
});

test('boots against the kernel protocol and renders a normal figure', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('#kernel-status')).toHaveText('kernel');
  const chart = page.getByText('chart', { exact: true });
  await expect(chart).toBeVisible();
  await chart.click();

  const figure = page.locator('.viewer .figure img');
  await expect(figure).toBeVisible();
  const renderedSvg = await figure.evaluate(async (element) => {
    const response = await fetch((element as HTMLImageElement).src);
    return response.text();
  });
  expect(renderedSvg).toContain('stroke="#336699"');
  await expect(page.locator('.viewer .figure svg')).toHaveCount(0);
});

test('pairs after an authorization rejection without reloading', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('knuth-agent-capability'));
  await page.goto('/');

  await expect(page.locator('#kernel-status')).toHaveText('kernel pairing required');
  page.once('dialog', (dialog) => dialog.accept(TEST_CAPABILITY));
  await page.getByRole('button', { name: 'Pair', exact: true }).click();

  await expect(page.locator('#kernel-status')).toHaveText('kernel');
  await expect(page.getByText('chart', { exact: true })).toBeVisible();
});

test('re-pairs an active app through a close-then-reattach', async ({ page }) => {
  await page.goto('/');
  const status = page.locator('#kernel-status');
  await expect(status).toHaveText('kernel');

  page.once('dialog', (dialog) => dialog.accept(TEST_CAPABILITY));
  await status.click();

  await expect(page.locator('#kernel-status')).toHaveText('kernel');
  await expect(page.getByText('chart', { exact: true })).toBeVisible();
});

test('bounds a single extremely long output line in browser memory', async ({ page }) => {
  await page.addInitScript(() => {
    (window as typeof window & { __knuthTestRunOutput?: string }).__knuthTestRunOutput =
      'x'.repeat(150_000);
  });
  await page.goto('/');

  await page.locator('.cell .run').first().click();
  const output = page.locator('.cell .output').first();
  await expect(output).toContainText('output display limit reached');
  const length = await output.evaluate((element) => element.textContent?.length ?? 0);
  expect(length).toBeLessThan(100_100);
});

test('renders malicious SVG as a sanitized inert image', async ({ page }) => {
  await page.addInitScript((svg) => {
    (window as typeof window & { __knuthTestFigureSvg?: string }).__knuthTestFigureSvg = svg;
  }, MALICIOUS_SVG);
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://attacker.example/')) {
      externalRequests.push(request.url());
    }
  });

  await page.goto('/');
  await page.getByText('chart', { exact: true }).click();

  const figure = page.locator('.viewer .figure img');
  await expect(figure).toBeVisible();
  const sanitizedSvg = await figure.evaluate(async (element) => {
    const response = await fetch((element as HTMLImageElement).src);
    return response.text();
  });
  const executed = await page.evaluate(
    () => (window as typeof window & { __knuthSvgExecuted?: string }).__knuthSvgExecuted,
  );

  expect(executed).toBeUndefined();
  expect(externalRequests).toEqual([]);
  expect(sanitizedSvg).toContain('id="safe-mark"');
  expect(sanitizedSvg).not.toMatch(
    /<script|foreignObject|\son\w+=|javascript:|attacker\.example/i,
  );
  await expect(page.locator('.viewer .figure svg')).toHaveCount(0);
});
