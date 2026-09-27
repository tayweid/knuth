// The page side of per-document environments (docs/ENVIRONMENT.md, APP.md)
// against a fake engine: the document path travels on attach and restart,
// the header the engine rewrites is spliced in place, and its events
// become toasts rather than receipts.
import { expect, test } from '@playwright/test';

const HEADER = ['# /// script', '# dependencies = ["seaborn"]', '# ///'];
type Probe = typeof window & {
  __knuthMessages?: Array<Record<string, unknown>>;
  __knuthTexts?: Record<string, string>;
  __knuthModified?: Record<string, number>;
  __knuthFallbackReason?: string;
  __knuthMissing?: boolean;
  __knuthScratch?: string;
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ header }) => {
    const probe = window as Probe;
    probe.__knuthMessages = [];
    probe.__knuthTexts = {
      '/p/analysis.py': '# %%\nx = 1\n',
      '/q/other.py': [...header, '', '# %%\ny = 2\n'].join('\n'),
    };
    // The fake disk's mtimes: a save or a header rewrite moves them, and
    // stat reports them, as the engine's files.py would.
    probe.__knuthModified = { '/p/analysis.py': 1000, '/q/other.py': 1000 };
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
        const texts = probe.__knuthTexts!;
        const modified = probe.__knuthModified!;
        switch (msg.type) {
          case 'attach':
            this.reply({ type: 'attached', protocol: msg.protocol, session: msg.session, resumed: false, root: msg.root ?? null });
            this.reply(probe.__knuthScratch
              ? {
                  type: 'environment',
                  document: probe.__knuthScratch,
                  state: 'ready',
                  python: '/uv/envs/s/bin/python',
                  managed: true,
                }
              : {
                  type: 'environment',
                  document: msg.document ?? null,
                  state: 'fallback',
                  python: '/usr/bin/python3',
                  managed: false,
                  reason: probe.__knuthFallbackReason ?? 'no header',
                });
            this.reply({ type: 'ready' });
            break;
          case 'restart':
            this.reply({ type: 'ready', id: msg.id });
            break;
          case 'open': {
            const path = String(msg.path);
            const text = texts[path];
            if (text === undefined) this.reply({ type: 'document', id: msg.id, error: 'no such file' });
            else this.reply({ type: 'document', id: msg.id, path, name: path.split('/').pop(), text, modified: modified[path] });
            break;
          }
          case 'save': {
            const path = String(msg.path);
            texts[path] = String(msg.text);
            modified[path] = (modified[path] ?? 0) + 1000;
            this.reply({ type: 'saved', id: msg.id, path, modified: modified[path] });
            break;
          }
          case 'stat': {
            const path = String(msg.path);
            this.reply({ type: 'stat', id: msg.id, path, modified: texts[path] === undefined ? null : modified[path] });
            break;
          }
          case 'run': {
            if (probe.__knuthMissing) {
              this.reply({
                type: 'error',
                id: msg.id,
                traceback: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'seaborn'",
              });
              break;
            }
            if (probe.__knuthScratch) {
              // A package listed after the run, in the session's scratch file.
              this.reply({ type: 'done', id: msg.id, result: null });
              this.reply({ type: 'header', id: msg.id, path: probe.__knuthScratch, lines: header, modified: 5000 });
              break;
            }
            // The engine installs for the cell, rewrites the header on
            // disk, and tells the page; the disk now carries the header.
            const path = '/p/analysis.py';
            this.reply({ type: 'dependency', id: msg.id, state: 'installing', module: 'seaborn', distribution: 'seaborn' });
            this.reply({ type: 'stream', id: msg.id, which: 'stdout', text: 'before the header\n' });
            texts[path] = [...header, '', texts[path]].join('\n');
            modified[path] = 3000;
            this.reply({ type: 'header', id: msg.id, path, lines: header, modified: 3000 });
            this.reply({ type: 'stream', id: msg.id, which: 'stdout', text: 'after the header\n' });
            this.reply({ type: 'done', id: msg.id, result: null });
            break;
          }
          case 'install': {
            probe.__knuthMissing = false;
            this.reply({ type: 'dependency', id: msg.id, state: 'installing', module: msg.module, distribution: msg.module });
            this.reply({ type: 'dependency', id: msg.id, state: 'installed', module: msg.module, distribution: msg.module, version: '0.13.2' });
            this.reply({ type: 'installed', id: msg.id, ok: true, restart: false });
            break;
          }
          case 'namespace':
            this.reply({ type: 'namespace', id: msg.id, vars: [] });
            break;
          case 'artifacts':
            this.reply({ type: 'artifacts', id: msg.id, values: {}, figures: {} });
            break;
          case 'persist':
            this.reply({ type: 'persisted', id: msg.id, root: '/p', values: 0, figures: [] });
            break;
          default:
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
  }, { header: HEADER });
});

async function messages(page: import('@playwright/test').Page) {
  return page.evaluate(() => (window as Probe).__knuthMessages!.filter((m) => !String(m.type).startsWith('vite')));
}

test('a launched document attaches with its folder and its path', async ({ page }) => {
  await page.goto('/?open=/p/analysis.py');
  // The pill names the Python: the fake engine reports a plain one.
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(page).toHaveTitle('analysis.py');
  await expect(page.getByText('x = 1')).toBeVisible();

  // Served by an engine (or inside the app): the website's download button
  // has no business here, and must not show.
  await expect(page.locator('#get-app')).toBeHidden();

  const attach = (await messages(page)).find((m) => m.type === 'attach');
  expect(attach).toMatchObject({ root: '/p', document: '/p/analysis.py' });
  // The opened document is the session's own: no restart at boot.
  expect((await messages(page)).some((m) => m.type === 'restart')).toBe(false);
});

test('the header the engine rewrites is spliced into the preamble', async ({ page }) => {
  await page.goto('/?open=/p/analysis.py');
  await expect(page.getByText('x = 1')).toBeVisible();

  await page.getByTitle('Run all program cells from the top').click();
  await expect(page.locator('#toast')).toContainText('Installing seaborn');
  await expect
    .poll(async () =>
      page.evaluate(() => JSON.parse(sessionStorage.getItem('knuth-doc')!).text as string),
    )
    .toBe([...HEADER, '', '# %%', 'x = 1', ''].join('\n'));
  // The splice moved only the preamble: the running cell kept its output
  // element, so what streamed after the header still landed.
  await expect(page.getByText('after the header')).toBeVisible();
  await expect(page.getByText('before the header')).toBeVisible();
  // Written by the engine, so nothing is left to save.
  await expect(page.locator('#file-name')).not.toContainText('●');
  // The engine's mtime was adopted: the poll never reloads over the splice.
  await page.waitForTimeout(2000);
  expect((await messages(page)).filter((m) => m.type === 'open').length).toBe(1);
});

test('opening another document restarts the session for that document', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('knuth-recent-paths', JSON.stringify([{ name: 'other.py', path: '/q/other.py', time: 1 }]));
  });
  await page.goto('/?open=/p/analysis.py');
  await expect(page.getByText('x = 1')).toBeVisible();

  // Recent lives in the hover flyout that lays over its own trigger, so a
  // pointer hover never settles; the click itself is what matters here.
  await page.getByTitle('Your documents').dispatchEvent('click');
  await page.getByText('other.py', { exact: true }).click();
  await expect(page.getByText('y = 2')).toBeVisible();
  await expect.poll(async () => (await messages(page)).find((m) => m.type === 'restart')).toMatchObject({
    root: '/q',
    document: '/q/other.py',
  });
});

test('a document with a header that fell back to the system Python says why', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Probe).__knuthFallbackReason = 'uv was not found';
  });
  await page.goto('/?open=/q/other.py');
  await expect(page.getByText('y = 2')).toBeVisible();
  // The fallback event arrived at attach, before the document opened; the
  // next session start (the restart for this document) tells the user.
  await expect(page.locator('#toast')).toContainText('uv was not found');
});

test('a missing import offers Install with uv, then runs the cell again', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Probe).__knuthMissing = true;
  });
  await page.goto('/?open=/p/analysis.py');
  await expect(page.getByText('x = 1')).toBeVisible();

  await page.getByTitle('Run all program cells from the top').click();
  await expect(page.locator('#toast')).toContainText("seaborn isn't installed");
  await page.locator('#toast').getByRole('button', { name: 'Install with uv' }).click();

  await expect.poll(async () => (await messages(page)).find((m) => m.type === 'install')).toMatchObject({
    module: 'seaborn',
  });
  // The cell ran again after the install, and nothing was installed before the click.
  await expect.poll(async () => (await messages(page)).filter((m) => m.type === 'run').length).toBe(2);
  await expect(page.locator('.output.error')).toHaveCount(0);
});

test('an unsaved document installs without being saved first', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Probe).__knuthMissing = true;
  });
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await page.getByTitle('Run all program cells from the top').click();
  await expect(page.locator('#toast')).toContainText("seaborn isn't installed");
  await page.locator('#toast').getByRole('button', { name: 'Install with uv' }).click();

  // No save: the install carries the document's text instead.
  await expect.poll(async () => (await messages(page)).find((m) => m.type === 'install')).toMatchObject({
    module: 'seaborn',
    text: expect.stringContaining('# %%'),
  });
  expect((await messages(page)).some((m) => m.type === 'save')).toBe(false);
  await expect.poll(async () => (await messages(page)).filter((m) => m.type === 'run').length).toBe(2);
});

test('the package header folds to one line, and opens on a click', async ({ page }) => {
  await page.goto('/?open=/q/other.py');
  await expect(page.getByText('y = 2')).toBeVisible();
  const summary = page.locator('.packages-summary');
  await expect(summary).toContainText('Packages');
  await expect(summary).toContainText('seaborn');
  await expect(page.getByText('# dependencies = ["seaborn"]')).toBeHidden();
  await summary.click();
  await expect(page.getByText('# dependencies = ["seaborn"]')).toBeVisible();
  await summary.click();
  await expect(page.getByText('# dependencies = ["seaborn"]')).toBeHidden();
});

test('a header from the session scratch environment lands in the document as an edit', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Probe).__knuthScratch = '/scratch/unsaved/s.py';
  });
  await page.goto('/?open=/p/analysis.py');
  await expect(page.locator('#kernel-status')).toHaveText('uv');
  await expect(page.getByText('x = 1')).toBeVisible();
  await page.getByTitle('Run all program cells from the top').click();
  // Folded to its summary, and marked unsaved so autosave carries it to disk.
  await expect(page.locator('.packages-summary')).toContainText('seaborn');
  await expect(page.locator('#file-name')).toContainText('●');
  // No restart for any of it.
  expect((await messages(page)).some((m) => m.type === 'restart')).toBe(false);
});
