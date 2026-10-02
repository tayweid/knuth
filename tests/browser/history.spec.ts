// The page's side of the shell's history view (shell.ts, answerRewinds;
// claerbout's README, "The history view"): a rewind's `save` answered with
// `saved`, its `reload` re-reading only the document whose path it names,
// the record told when a run raised, and File → History…. The shell is a
// mock `window.claerbout` over an in-page disk, which the mock engine's
// file requests share, as files.py and the shell share the real one.
import { expect, test, type Page } from '@playwright/test';

interface Disk {
  [path: string]: { text: string; modified: number };
}
interface Probe {
  __disk: Disk;
  __log: string[];
  __sent: Array<Record<string, unknown>>;
  __historyAnswer: unknown;
  __fire: (event: string, detail: unknown) => void;
}
type ProbeWindow = Window & Probe;

const DOC = '/tmp/week-3/fit.py';
const SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const probe = window as unknown as ProbeWindow;
    probe.__disk = {};
    probe.__log = [];
    probe.__sent = [];
    probe.__historyAnswer = { opened: true };
    let clock = 1_000;
    const write = (path: string, text: string) => {
      clock += 1_000;
      probe.__disk[path] = { text, modified: clock };
      probe.__log.push(`write ${path}`);
      return probe.__disk[path];
    };

    const listeners = new Map<string, Set<(detail: unknown) => void>>();
    probe.__fire = (event, detail) => {
      for (const listener of listeners.get(event) ?? []) listener(detail);
    };
    Object.defineProperty(window, 'claerbout', {
      configurable: true,
      value: {
        request: async (message: Record<string, unknown>) => {
          probe.__sent.push(message);
          const path = message.path as string;
          switch (message.type) {
            case 'read': {
              const file = probe.__disk[path];
              return file
                ? { path, name: path.split('/').pop(), text: file.text, modified: file.modified }
                : { error: `${path} does not exist` };
            }
            case 'write':
              return { path, ...write(path, message.text as string) };
            case 'saved':
              probe.__log.push(`saved ${String(message.id)}`);
              return null;
            case 'history':
              return probe.__historyAnswer;
            default:
              return null;
          }
        },
        on: (event: string, listener: (detail: unknown) => void) => {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(listener);
          return () => listeners.get(event)!.delete(listener);
        },
      },
    });

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
        switch (msg.type) {
          case 'attach':
            this.reply({ type: 'attached', protocol: msg.protocol, session: msg.session, resumed: false });
            this.reply({ type: 'ready' });
            break;
          case 'run':
            if (/raise/.test(msg.code)) this.reply({ type: 'error', id: msg.id, traceback: 'ValueError: no fit' });
            else this.reply({ type: 'done', id: msg.id, result: null });
            break;
          case 'save': {
            const saved = write(msg.path, msg.text);
            this.reply({ type: 'saved', id: msg.id, path: msg.path, modified: saved.modified });
            break;
          }
          case 'stat': {
            const file = probe.__disk[msg.path];
            this.reply({ type: 'stat', id: msg.id, path: msg.path, modified: file ? file.modified : null });
            break;
          }
          case 'persist':
            this.reply({ type: 'persisted', id: msg.id, root: '/tmp/week-3', values: 0, figures: [] });
            break;
          case 'artifacts':
            this.reply({ type: 'artifacts', id: msg.id, values: {}, figures: {} });
            break;
          case 'namespace':
            this.reply({ type: 'namespace', id: msg.id, vars: [] });
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
  });
});

/** Knuth.app's launch: the shell opens the page on a document by path. */
async function open(page: Page, text: string) {
  await page.addInitScript(
    ({ path, text }) => {
      (window as unknown as ProbeWindow).__disk[path] = { text, modified: 1_000 };
    },
    { path: DOC, text },
  );
  await page.goto(`/?open=${encodeURIComponent(DOC)}`);
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(page.locator('#file-name')).toHaveText('fit.py');
}

const fire = (page: Page, event: string, detail: unknown) =>
  page.evaluate(([event, detail]) => (window as unknown as ProbeWindow).__fire(event as string, detail), [event, detail] as const);
const sent = (page: Page, type: string) =>
  page.evaluate((type) => (window as unknown as ProbeWindow).__sent.filter((message) => message.type === type), type);
const disk = (page: Page) => page.evaluate((path) => (window as unknown as ProbeWindow).__disk[path]?.text, DOC);
const log = (page: Page) => page.evaluate(() => (window as unknown as ProbeWindow).__log);

test('a rewind’s save is answered at once when nothing is unsaved, and after the write when something is', async ({ page }) => {
  await open(page, '# %%\nx = 1\n');
  await fire(page, 'save', { id: 'clean', reason: 'rewind' });
  await expect.poll(() => sent(page, 'saved')).toEqual([{ type: 'saved', id: 'clean', ok: true }]);
  expect(await log(page)).toEqual(['saved clean']);

  // Typed, and asked before the autosave's 1.2 s are up: written first
  // (through the engine, ⌘S's write), answered after.
  await page.locator('.cell .cm-content').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' + 1');
  await fire(page, 'save', { id: 'typed', reason: 'rewind' });
  await expect.poll(() => sent(page, 'saved')).toHaveLength(2);
  expect((await sent(page, 'saved'))[1]).toEqual({ type: 'saved', id: 'typed', ok: true });
  expect(await log(page)).toEqual(['saved clean', `write ${DOC}`, 'saved typed']);
  const typed = await disk(page);
  expect(typed).toMatch(/^# %%\nx = 1 \+ 1\n/);

  // Until the rewind is over the autosave holds, so it cannot write back
  // over the file being restored; a reload that does not name this
  // document ends the hold, and the edit is written.
  await page.keyboard.type(' + 2');
  await page.waitForTimeout(2_000);
  expect(await disk(page)).toBe(typed);
  await fire(page, 'reload', { id: 'r', paths: ['/private/tmp/week-3/data.csv'], reason: 'rewind', to: SHA });
  await expect.poll(() => disk(page)).toMatch(/^# %%\nx = 1 \+ 1 \+ 2\n/);
});

test('a document with no file answers that it could not be saved', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await fire(page, 'save', { id: 'homeless', reason: 'rewind' });
  await expect.poll(() => sent(page, 'saved')).toEqual([
    { type: 'saved', id: 'homeless', ok: false, error: 'Knuth.py is not saved to a file yet' },
  ]);
});

test('a reload re-reads only the document whose path it names, in place', async ({ page }) => {
  const cells = Array.from({ length: 30 }, (_, i) => `# %%\nv${i + 1} = ${i + 1}\n`).join('\n');
  await open(page, cells);
  const wraps = page.locator('#sheet > .cell-wrap');
  await expect(wraps).toHaveCount(30);
  // The place: the room scrolled down, the cursor in cell 12.
  await wraps.nth(11).locator('.cm-content').click();
  await page.keyboard.press('End');
  const top = await page.locator('#doc').evaluate((doc) => {
    doc.scrollTop = 600;
    return doc.scrollTop;
  });
  expect(top).toBeGreaterThan(0);
  const reads = async () => (await sent(page, 'read')).filter((message) => message.path === DOC).length;
  const readsBefore = await reads();

  // Another file rewound: nothing re-read, nothing said.
  await fire(page, 'save', { id: 's1', reason: 'rewind' });
  await fire(page, 'reload', { id: 'r1', paths: ['/private/tmp/week-3/data.csv', '/private/tmp/week-3/fit.py.bak'], reason: 'rewind', to: SHA });
  await page.waitForTimeout(500);
  expect(await reads()).toBe(readsBefore);
  await expect(page.locator('#toast')).toBeHidden();

  // This one, as git names it (/private/tmp is the /tmp the page was
  // given): re-read through the shell, replaced in place.
  await fire(page, 'save', { id: 's2', reason: 'rewind' });
  await page.evaluate(
    ({ path, text }) => {
      (window as unknown as ProbeWindow).__disk[path] = { text, modified: 99_000 };
    },
    { path: DOC, text: cells.replace('v12 = 12', 'v12 = "rewound"') },
  );
  await fire(page, 'reload', { id: 'r2', paths: ['/private/tmp/week-3/fit.py'], reason: 'rewind', to: SHA });
  await expect(wraps.nth(11)).toContainText('v12 = "rewound"');
  expect(await reads()).toBe(readsBefore + 1);
  await expect(page.locator('#toast')).toHaveText('Rewound to 1a2b3c4; the session is as it was, so every cell is stale');
  // The place kept: the scroll, and the focus in cell 12.
  await expect.poll(() => page.locator('#doc').evaluate((doc) => doc.scrollTop)).toBe(top);
  expect(await page.evaluate(() => {
    const wraps = [...document.querySelectorAll('#sheet > .cell-wrap')];
    return wraps.findIndex((wrap) => wrap.contains(document.activeElement));
  })).toBe(11);
  // Not rewound, the session: every program cell is stale.
  await expect(page.locator('#sheet .cell.stale')).toHaveCount(30);
  // Clean: the reload is what the disk holds, so nothing is written back.
  await page.waitForTimeout(1_600);
  expect(await disk(page)).toContain('v12 = "rewound"');
  await expect(page.locator('#doc-pod')).toHaveClass(/doc-saved/);

  // Another app's rewind says whose.
  await page.evaluate((path) => {
    (window as unknown as ProbeWindow).__disk[path] = { text: '# %%\nv1 = "plass"\n', modified: 120_000 };
  }, DOC);
  await fire(page, 'reload', { id: 'r3', paths: [DOC], reason: 'rewind', to: SHA, app: 'plass' });
  await expect(wraps).toHaveCount(1);
  await expect(page.locator('#toast')).toHaveText('Rewound by Plass to 1a2b3c4; the session is as it was, so every cell is stale');
});

test('a run that raised is recorded as one, numbered as the history view numbers # %% blocks', async ({ page }) => {
  // A text cell between: the raising cell is the third `# %%` block, the
  // number the shell's history view gives the cell its commit lights (the
  // receipt, counting code cells only, says Cell 2).
  await open(page, '# %%\nx = 1\n\n# %% [markdown]\n# Some words.\n\n# %%\nraise ValueError("no fit")\n');
  const triggers = async () => (await sent(page, 'autosave')).map((message) => message.trigger);
  await page.locator('.cell .run').nth(0).click();
  await expect.poll(triggers, { timeout: 5_000 }).toEqual(['cell run [1]']);
  await page.locator('.cell .run').nth(1).click();
  await expect.poll(triggers, { timeout: 5_000 }).toEqual(['cell run [1]', 'cell run [3] (error)']);
});

test('File → History… asks the shell for the view, and says why when there is none', async ({ page }) => {
  await open(page, '# %%\nx = 1\n');
  const item = page.getByRole('menuitem', { name: 'History…' });
  await page.locator('#file-tile').click();
  await expect(item).toBeVisible();
  await expect(item.locator('kbd')).toHaveText('⇧⌘H');
  await item.click();
  await expect.poll(() => sent(page, 'history')).toEqual([{ type: 'history', action: 'open' }]);
  // Opened: the shell's window is the answer, nothing to say here.
  await page.waitForTimeout(300);
  await expect(page.locator('#toast')).toBeHidden();

  // An older shell has no view.
  await page.evaluate(() => {
    (window as unknown as ProbeWindow).__historyAnswer = null;
  });
  await page.locator('#file-tile').click();
  await item.click();
  await expect(page.locator('#toast')).toHaveText('This Knuth.app has no history view: a newer shell brings it');

  // A shell that answers why, in the folder rule's words.
  await page.evaluate(() => {
    (window as unknown as ProbeWindow).__historyAnswer = { reason: 'refused', detail: '~/Desktop itself is never recorded' };
  });
  await page.locator('#file-tile').click();
  await item.click();
  await expect(page.locator('#toast')).toHaveText('No history here: ~/Desktop itself is never recorded');
});

test('a plain tab has no History item', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { claerbout?: unknown }).claerbout;
  });
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await page.locator('#file-tile').click();
  await expect(page.getByRole('menuitem', { name: 'Open…' })).toBeVisible();
  await expect(page.locator('#open-history')).toBeHidden();
});
