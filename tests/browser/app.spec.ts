import { expect, test } from '@playwright/test';

type WindowWithProbe = typeof window & {
  __knuthSocketUrl?: string;
  __knuthRefuseConnections?: boolean;
  __knuthRecordAttach?: (msg: Record<string, unknown>) => void;
};

const FIGURE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">
  <rect width="240" height="120" fill="#f7f4ed"/>
  <path d="M20 100 L80 55 L140 75 L220 20" fill="none" stroke="#336699" stroke-width="4"/>
</svg>`;
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
  await page.addInitScript(({ figureSvg }) => {
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
        const probe = window as WindowWithProbe;
        // Vite's own HMR socket goes through this mock too; only the engine
        // socket is the app's.
        if (!this.url.includes('/@vite')) probe.__knuthSocketUrl = this.url;
        window.setTimeout(() => {
          if (probe.__knuthRefuseConnections && !this.url.includes('/@vite')) {
            this.readyState = MockWebSocket.CLOSED;
            this.dispatchEvent(new CloseEvent('close'));
            return;
          }
          this.readyState = MockWebSocket.OPEN;
          this.dispatchEvent(new Event('open'));
        });
      }

      send(raw: string) {
        const msg = JSON.parse(raw);
        if (msg.type === 'attach') {
          const record = (window as WindowWithProbe).__knuthRecordAttach;
          if (record) record(msg);
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
  }, { figureSvg: FIGURE_SVG });
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

test('connects with no credential, to the origin that served the page', async ({ page }) => {
  const attaches: Array<Record<string, unknown>> = [];
  await page.exposeFunction('__knuthRecordAttach', (msg: Record<string, unknown>) => {
    attaches.push(msg);
  });
  await page.goto('/');

  await expect(page.locator('#kernel-status')).toHaveText('kernel');
  expect(attaches).toHaveLength(1);
  expect(attaches[0]).not.toHaveProperty('capability');
  expect(attaches[0]).not.toHaveProperty('pairing');
  const socketUrl = await page.evaluate(() => (window as WindowWithProbe).__knuthSocketUrl);
  expect(socketUrl, 'the socket goes back to this page\'s own origin')
    .toBe(`ws://${new URL(page.url()).host}`);
});

test('nothing about pairing survives in storage', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('kernel');

  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).not.toContain('knuth-agent-capability');
});

test('waits for an engine that is not running yet, then connects', async ({ page }) => {
  // A window restored from the service worker cache with no engine behind it:
  // it must explain itself and keep trying, not die.
  await page.addInitScript(() => {
    (window as WindowWithProbe).__knuthRefuseConnections = true;
  });
  await page.goto('/');

  await expect(page.locator('#kernel-status')).toHaveText('Python engine unavailable');
  await expect(page.getByRole('heading', { name: 'Start the local Python engine' })).toBeVisible();
  await expect(page.getByText('knuth app', { exact: true }).first()).toBeVisible();

  await page.evaluate(() => {
    (window as WindowWithProbe).__knuthRefuseConnections = false;
  });
  await expect(page.locator('#kernel-status')).toHaveText('kernel', { timeout: 15_000 });
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

test('a locally served window is told to start the engine, not to install it', async ({ page }) => {
  // The dev server is on 127.0.0.1, so this page counts as locally served: the
  // engine exists — it served the page — it just is not running. Leading with
  // "install" would be advice for a problem the user does not have.
  await page.addInitScript(() => {
    (window as WindowWithProbe).__knuthRefuseConnections = true;
  });
  await page.goto('/');

  await expect(
    page.getByRole('heading', { name: 'Start the local Python engine' }),
  ).toBeVisible();
  await expect(page.locator('.onboarding-step h2').first()).toHaveText('Start Knuth');
  await expect(page.getByText('served by the engine on')).toBeVisible();
  await expect(page.locator('.onboarding-install-step')).toHaveCount(1);
});

test('a file opened from a folder Knuth already holds does not ask again', async ({ page }) => {
  // The browser withholds a launched file's path and will not hand over a
  // directory without a gesture — but it will confirm that a file sits inside
  // a directory already granted. That is enough to stop asking twice.
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('kernel');

  const adopted = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle('project', { create: true });
    const file = await folder.getFileHandle('analysis.py', { create: true });
    const writable = await file.createWritable();
    await writable.write('# %%\nx = 1\n');
    await writable.close();

    // Same file, reached the way a launch delivers it: a bare handle.
    const launched = await folder.getFileHandle('analysis.py');
    const candidate = await folder.getFileHandle(launched.name);
    return {
      sameFile: await candidate.isSameEntry(launched),
      differentFolder: await folder.isSameEntry(root),
    };
  });

  expect(adopted.sameFile, 'a held folder can identify its own file').toBe(true);
  expect(adopted.differentFolder).toBe(false);
});

test('a script with no cells opens as a file, and gains the workbench when given one', async ({ page }) => {
  // Seed the session the way a reload would, with a plain script: no markers,
  // so it parses to one body and zero cells.
  await page.addInitScript(() => {
    sessionStorage.setItem('knuth-doc', JSON.stringify({
      name: 'script.py',
      dirty: false,
      text: 'import math\n\nprint(math.pi)\n',
    }));
  });
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('kernel');

  await expect(page.locator('body')).toHaveAttribute('data-plain', 'true');
  const hidden = ['.run', '.badge', '.insert-zone', '#panel', '#run-all', '#restart',
                  '#cells-pod'];
  for (const gone of hidden) {
    await expect(page.locator(gone).first(), `${gone} is noise on a plain file`)
      .toBeHidden();
  }
  // The text itself is still there, still editable, and numbered.
  await expect(page.locator('.cm-content').first()).toContainText('import math');
  await expect(page.locator('.cm-lineNumbers').first()).toBeVisible();

  // With no cell buttons, typing a marker is the way in — and it has to work,
  // or a file that looks structured would keep behaving flat.
  await page.locator('.cm-content').first().click();
  await page.keyboard.press('ControlOrMeta+ArrowUp');
  await page.keyboard.type('# %%\n');

  await expect(page.locator('body')).toHaveAttribute('data-plain', '');
  await expect(page.locator('.run').first()).toBeVisible();
  await expect(page.locator('#run-all')).toBeVisible();
  await expect(page.locator('#cells-pod')).toBeVisible();
});
