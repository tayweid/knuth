// Closing with unsaved work (shell.ts, unsavedReporter and answerRewinds;
// claerbout's README, "The protocol"): inside the shell the page tells
// it, by `unsaved`, whether closing now would lose work and what Save can
// do, and answers a close's `save` ({reason: 'close', choose}) — quietly
// for a document with a file, through the save panel for one without when
// the close dialog's Save asks; in a plain tab Chrome's "Leave site?" asks
// instead, and never inside a shell, where Electron would only refuse the
// close without a word. The shell is a mock `window.claerbout` over an
// in-page disk, which the mock engine's file requests share (as in
// history.spec.ts).
import { expect, test, type Page } from '@playwright/test';

interface Disk {
  [path: string]: { text: string; modified: number };
}
interface Probe {
  __disk: Disk;
  __log: string[];
  __sent: Array<Record<string, unknown>>;
  /** What the shell answers `unsaved` with: {guarded: true}, or an older
   *  shell's null. */
  __guard: unknown;
  /** The save panel's answer: a path, or null for Cancel. */
  __savePanel: string | null;
  __fire: (event: string, detail: unknown) => void;
}
type ProbeWindow = Window & Probe;

const DOC = '/tmp/week-3/fit.py';

/** The mock engine, always; the mock shell unless the test is a plain tab. */
async function mock(page: Page, { shell = true, guard = { guarded: true } as unknown } = {}) {
  await page.addInitScript(
    ({ shell, guard }) => {
      const probe = window as unknown as ProbeWindow;
      probe.__disk = {};
      probe.__log = [];
      probe.__sent = [];
      probe.__guard = guard;
      probe.__savePanel = null;
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
      if (shell) {
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
                case 'saveAs':
                  return { path: probe.__savePanel };
                case 'unsaved':
                  return probe.__guard;
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
      }

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
              this.reply({ type: 'done', id: msg.id, result: null });
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
    },
    { shell, guard },
  );
}

/** Knuth.app's launch on a document by path. */
async function open(page: Page, text: string, path = DOC) {
  await page.addInitScript(
    ({ path, text }) => {
      (window as unknown as ProbeWindow).__disk[path] = { text, modified: 1_000 };
    },
    { path, text },
  );
  await page.goto(`/?open=${encodeURIComponent(path)}`);
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(page.locator('#file-name')).toHaveText(path.split('/').pop()!);
}

async function blank(page: Page) {
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(page.locator('#file-name')).toHaveText('Knuth.py');
}

const fire = (page: Page, event: string, detail: unknown) =>
  page.evaluate(([event, detail]) => (window as unknown as ProbeWindow).__fire(event as string, detail), [event, detail] as const);
const sent = (page: Page, type: string) =>
  page.evaluate((type) => (window as unknown as ProbeWindow).__sent.filter((message) => message.type === type), type);
/** The state the shell was last told. */
const told = async (page: Page) => (await sent(page, 'unsaved')).at(-1);
const disk = (page: Page, path = DOC) => page.evaluate((path) => (window as unknown as ProbeWindow).__disk[path]?.text, path);
const log = (page: Page) => page.evaluate(() => (window as unknown as ProbeWindow).__log);

async function typeInFirstCell(page: Page, text: string) {
  await page.locator('.cell .cm-content').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

/** Whether the page's beforeunload would ask now (a synthetic event, so
 *  nothing unloads): the edit has reached the document. */
const wouldAsk = (page: Page) =>
  page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

/** Close the page as a person does, beforeunload and all; the dialogs it
 *  raised are dismissed (Stay), and listed. */
async function closeAsked(page: Page): Promise<string[]> {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  // Not the page's clock: it may be gone.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return dialogs;
}

test('a document with a file: the shell is told when closing would lose an edit, and a close’s save writes it quietly', async ({ page }) => {
  await mock(page);
  await open(page, '# %%\nx = 1\n');
  // Once after load: nothing to lose, and Save would write the file.
  await expect.poll(() => told(page)).toEqual({ type: 'unsaved', unsaved: false, name: 'fit.py', save: 'quiet' });

  // An edit not yet on disk (the autosave waits 1.2 s), then the shell's
  // close: written now, answered ok, and the shell told it is safe.
  await typeInFirstCell(page, ' + 1');
  await expect.poll(() => told(page)).toEqual({ type: 'unsaved', unsaved: true, name: 'fit.py', save: 'quiet' });
  await fire(page, 'save', { id: 'q1', reason: 'close', choose: false });
  await expect.poll(() => sent(page, 'saved')).toEqual([{ type: 'saved', id: 'q1', ok: true }]);
  expect(await disk(page)).toMatch(/^# %%\nx = 1 \+ 1\n/);
  await expect.poll(() => told(page)).toEqual({ type: 'unsaved', unsaved: false, name: 'fit.py', save: 'quiet' });
  // Only state changes are told, not every keystroke.
  const reports = (await sent(page, 'unsaved')).length;
  expect(reports).toBe(3);

  // A close holds nothing (unlike a rewind's save): when the person
  // cancels and goes on typing, the autosave writes as before.
  await page.keyboard.type(' + 2');
  await expect.poll(() => disk(page)).toMatch(/^# %%\nx = 1 \+ 1 \+ 2\n/);
  await expect.poll(() => told(page)).toEqual({ type: 'unsaved', unsaved: false, name: 'fit.py', save: 'quiet' });
  expect((await sent(page, 'unsaved')).length).toBe(reports + 2);
  // Nothing unsaved: answered ok at once, with no write.
  const writes = (await log(page)).length;
  await fire(page, 'save', { id: 'q2', reason: 'close', choose: false });
  await expect.poll(async () => (await sent(page, 'saved')).at(-1)).toEqual({ type: 'saved', id: 'q2', ok: true });
  expect((await log(page)).length).toBe(writes);
});

test('a new document closes without asking until something is written in it; then Save… asks where, and a cancelled panel keeps the window', async ({ page }) => {
  await mock(page);
  await blank(page);
  await expect.poll(() => told(page)).toEqual({ type: 'unsaved', unsaved: false, name: 'Knuth.py', save: 'choose' });

  await typeInFirstCell(page, 'y = 2');
  await expect.poll(() => told(page)).toEqual({ type: 'unsaved', unsaved: true, name: 'Knuth.py', save: 'choose' });
  // Emptied again: nothing to lose.
  for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
  await expect.poll(() => told(page)).toEqual({ type: 'unsaved', unsaved: false, name: 'Knuth.py', save: 'choose' });
  await page.keyboard.type('y = 2');
  await expect.poll(() => told(page)).toEqual({ type: 'unsaved', unsaved: true, name: 'Knuth.py', save: 'choose' });

  // The quiet write cannot: it has no file (the shell then shows its sheet).
  await fire(page, 'save', { id: 'c1', reason: 'close', choose: false });
  await expect.poll(() => sent(page, 'saved')).toEqual([
    { type: 'saved', id: 'c1', ok: false, error: 'Knuth.py is not saved to a file yet' },
  ]);
  expect(await sent(page, 'saveAs')).toEqual([]);

  // Save… with the panel cancelled: not saved, and the window stays.
  await fire(page, 'save', { id: 'c2', reason: 'close', choose: true });
  await expect.poll(async () => (await sent(page, 'saved')).at(-1)).toEqual({
    type: 'saved',
    id: 'c2',
    ok: false,
    error: 'Knuth.py was not saved',
  });
  expect(await sent(page, 'saveAs')).toEqual([{ type: 'saveAs', name: 'Knuth.py' }]);

  // Save… with a place chosen: written there, then ok — and the shell is
  // told the document now has a file and nothing to lose.
  await page.evaluate(() => ((window as unknown as ProbeWindow).__savePanel = '/tmp/week-3/fit2.py'));
  await fire(page, 'save', { id: 'c3', reason: 'close', choose: true });
  await expect.poll(async () => (await sent(page, 'saved')).at(-1)).toEqual({ type: 'saved', id: 'c3', ok: true });
  expect(await disk(page, '/tmp/week-3/fit2.py')).toMatch(/^# %%\ny = 2\n/);
  await expect.poll(() => told(page)).toEqual({ type: 'unsaved', unsaved: false, name: 'fit2.py', save: 'quiet' });
  await expect(page.locator('#file-name')).toHaveText('fit2.py');
});

test('a rewind’s save still holds the autosave, and a close during the hold does not write over the rewind', async ({ page }) => {
  await mock(page);
  await open(page, '# %%\nx = 1\n');
  await typeInFirstCell(page, ' + 1');
  await fire(page, 'save', { id: 'r1', reason: 'rewind' });
  await expect.poll(() => sent(page, 'saved')).toEqual([{ type: 'saved', id: 'r1', ok: true }]);
  const rewound = await disk(page);
  await page.keyboard.type(' + 2');
  await fire(page, 'save', { id: 'c1', reason: 'close', choose: false });
  await expect.poll(async () => (await sent(page, 'saved')).at(-1)).toEqual({
    type: 'saved',
    id: 'c1',
    ok: false,
    error: 'a rewind is restoring it; close again in a moment',
  });
  expect(await disk(page)).toBe(rewound);
});

test('under an older shell (null to `unsaved`) the page tells it once and never again, and never holds the window by beforeunload', async ({ page }) => {
  await mock(page, { guard: null });
  await open(page, '# %%\nx = 1\n');
  await expect.poll(() => sent(page, 'unsaved')).toHaveLength(1);
  await typeInFirstCell(page, ' + 1');
  await expect(page.locator('#doc-pod')).toHaveClass(/doc-unsaved/);
  expect(await sent(page, 'unsaved')).toHaveLength(1);
  // Dirty, and closing raises no dialog: Electron would refuse the close
  // without one.
  expect(await closeAsked(page)).toEqual([]);
  expect(page.isClosed()).toBe(true);
});

test('inside a guarding shell the page leaves the asking to it: no beforeunload', async ({ page }) => {
  await mock(page);
  await blank(page);
  await typeInFirstCell(page, 'y = 2');
  await expect.poll(() => told(page)).toEqual({ type: 'unsaved', unsaved: true, name: 'Knuth.py', save: 'choose' });
  expect(await closeAsked(page)).toEqual([]);
  expect(page.isClosed()).toBe(true);
});

// A plain tab (the page fixture's own: a page from browser.newPage() owns
// its context, and closing it skips beforeunload).
test('a plain tab asks with Chrome’s “Leave site?” while closing would lose work, and Stay keeps it', async ({ page }) => {
  await mock(page, { shell: false });
  await blank(page);
  expect(await wouldAsk(page)).toBe(false);
  await typeInFirstCell(page, 'y = 2');
  await expect.poll(() => wouldAsk(page)).toBe(true);
  expect(await closeAsked(page)).toEqual(['beforeunload']);
  expect(page.isClosed()).toBe(false);
});

test('a plain tab closes without asking when a new document was written in and emptied again', async ({ page }) => {
  await mock(page, { shell: false });
  await blank(page);
  await typeInFirstCell(page, 'y');
  await expect.poll(() => wouldAsk(page)).toBe(true);
  await page.keyboard.press('Backspace');
  await expect.poll(() => wouldAsk(page)).toBe(false);
  expect(await closeAsked(page)).toEqual([]);
  expect(page.isClosed()).toBe(true);
});
