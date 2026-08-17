import { expect, test } from '@playwright/test';

const FIGURE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">
  <rect width="240" height="120" fill="#f7f4ed"/>
  <path d="M20 100 L80 55 L140 75 L220 20" fill="none" stroke="#336699" stroke-width="4"/>
</svg>`;
const TEST_CAPABILITY = 'c'.repeat(43);
const TEST_PAIRING = 'p'.repeat(43);
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
  await page.addInitScript(({ figureSvg, capability, pairing }) => {
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
        // Every kernel socket is a session the server may fork. (Vite's own
        // HMR socket goes through this mock too, so count only the engine.)
        if (this.url.includes('127.0.0.1:5197')) {
          const counted = window as typeof window & { __knuthSocketCount?: number };
          counted.__knuthSocketCount = (counted.__knuthSocketCount ?? 0) + 1;
        }
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.dispatchEvent(new Event('open'));
        });
      }

      send(raw: string) {
        const msg = JSON.parse(raw);
        if (msg.type === 'attach') {
          if (msg.capability !== capability && msg.pairing !== pairing) {
            this.reply({ type: msg.pairing ? 'pairing_expired' : 'unauthorized' });
            window.setTimeout(() => this.close());
            return;
          }
          if (msg.capability !== capability) {
            this.reply({ type: 'paired', protocol: msg.protocol, capability });
          }
          this.reply({
            type: 'attached',
            protocol: msg.protocol,
            session: msg.session,
            resumed: false,
          });
          this.reply({ type: 'ready' });
        } else if (msg.type === 'namespace') {
          const testWindow = window as typeof window & { __knuthMalformedNamespace?: boolean };
          if (testWindow.__knuthMalformedNamespace) {
            this.reply({ type: 'namespace', id: msg.id, vars: 'not an array' });
            return;
          }
          this.reply({
            type: 'namespace',
            id: msg.id,
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
            id: msg.id,
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
  }, { figureSvg: FIGURE_SVG, capability: TEST_CAPABILITY, pairing: TEST_PAIRING });
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

test('automatically exchanges and scrubs a one-time pairing fragment', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('knuth-agent-capability'));
  await page.goto(`/#pair=${TEST_PAIRING}`);

  await expect(page.locator('#kernel-status')).toHaveText('kernel');
  expect(new URL(page.url()).hash).toBe('');
  const stored = await page.evaluate(() => localStorage.getItem('knuth-agent-capability'));
  expect(stored).toBe(TEST_CAPABILITY);
});

test('spends a pairing fragment that arrives in an already-open window', async ({ page }) => {
  // The OS hands a launch URL to the window that is already up, so only the
  // fragment changes and nothing reloads — the case a Finder double-click hits.
  await page.addInitScript(() => localStorage.removeItem('knuth-agent-capability'));
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('kernel pairing required');

  await page.evaluate((token) => {
    window.location.hash = `pair=${token}`;
  }, TEST_PAIRING);

  await expect(page.locator('#kernel-status')).toHaveText('kernel');
  expect(new URL(page.url()).hash).toBe('');
  const stored = await page.evaluate(() => localStorage.getItem('knuth-agent-capability'));
  expect(stored).toBe(TEST_CAPABILITY);
});

test('an unpaired window recovers when another one pairs the profile', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('knuth-agent-capability'));
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('kernel pairing required');

  // What a second window pairing this origin looks like from here.
  await page.evaluate((capability) => {
    localStorage.setItem('knuth-agent-capability', capability);
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'knuth-agent-capability',
      newValue: capability,
    }));
  }, TEST_CAPABILITY);

  await expect(page.locator('#kernel-status')).toHaveText('kernel');
});

test('an unpaired window heals without a reload or a storage event', async ({ page }) => {
  // A file-handler launch opens a window with no pairing fragment. If the
  // capability then lands in this profile without a storage event reaching
  // here — a fresh window, a paired sibling already closed — the slow
  // pairing retry is the only thing that ever picks it up.
  test.slow(); // deliberately waits out one PAIRING_RETRY_MS
  await page.addInitScript(() => localStorage.removeItem('knuth-agent-capability'));
  await page.goto('/');

  const status = page.locator('#kernel-status');
  await expect(status).toHaveText('kernel pairing required');
  await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible();

  await page.evaluate(
    (capability) => localStorage.setItem('knuth-agent-capability', capability),
    TEST_CAPABILITY,
  );

  await expect(status).toHaveText('kernel', { timeout: 30_000 });
  const sockets = await page.evaluate(
    () => (window as typeof window & { __knuthSocketCount?: number }).__knuthSocketCount,
  );
  expect(sockets, 'one rejected attach, then one that pairs').toBe(2);
});

test('explains an expired automatic pairing without retrying forever', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('knuth-agent-capability'));
  await page.goto('/#pair=expired-token');

  await expect(page.locator('#kernel-status')).toHaveText('kernel pairing link expired');
  await expect(page.getByRole('heading', { name: 'The secure pairing link expired' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
});

test('shows cross-platform install and start commands when pairing is required', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('knuth-agent-capability'));
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible();
  await page.getByRole('tab', { name: 'Windows' }).click();
  await expect(page.locator('#engine-install-command')).toHaveText(
    'py -m pip install --upgrade --force-reinstall "knuth @ https://github.com/tayweid/knuth/archive/refs/heads/main.zip#subdirectory=python"',
  );
  await expect(page.getByText('knuth app --hosted', { exact: true }).first()).toBeVisible();
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

test('refuses to initialize when another page embeds the app', async ({ page }) => {
  await page.setContent('<iframe title="embedded Knuth" src="http://127.0.0.1:5198/"></iframe>');

  const embedded = page.frameLocator('iframe[title="embedded Knuth"]');
  await expect(
    embedded.getByText('For your security, open Knuth directly in its own window.'),
  ).toBeVisible();
  await expect(embedded.locator('#toolbar')).toHaveCount(0);
});

test('fails closed on a malformed event from the local engine', async ({ page }) => {
  await page.addInitScript(() => {
    (window as typeof window & { __knuthMalformedNamespace?: boolean })
      .__knuthMalformedNamespace = true;
  });
  await page.goto('/');

  await expect(page.locator('#kernel-status')).toHaveText('Python engine unavailable');
});
