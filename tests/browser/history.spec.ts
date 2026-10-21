// The page's side of the shell's history view (shell.ts, answerRewinds;
// claerbout's README, "The history view"): a rewind's `save` answered with
// `saved`, its `reload` re-reading only the document whose path it names,
// the record told when a run raised, and the History tile in
// the name pill (one way in, with the shell's ⇧⌘H), which lays the shell's
// History page over the room of the same window and put it away again.
// The shell is a mock `window.claerbout` over an in-page disk, which the
// mock engine's file requests share, as files.py and the shell share the
// real one; its History view is a flag it says `history {kind: 'inline'}`
// about, as the shell does.
import { expect, test, type Page } from '@playwright/test';

interface Disk {
  [path: string]: { text: string; modified: number };
}
interface Probe {
  __disk: Disk;
  __log: string[];
  __sent: Array<Record<string, unknown>>;
  /** 'shell': answered as the shell answers, the view a flag; else the
   *  answer itself, with no view. */
  __historyAnswer: unknown;
  __inlineUp: boolean;
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
    probe.__historyAnswer = 'shell';
    probe.__inlineUp = false;
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
            case 'history': {
              if (probe.__historyAnswer !== 'shell') return probe.__historyAnswer;
              const tell = (state: string) => window.setTimeout(() => probe.__fire('history', { kind: 'inline', state }));
              if (message.action === 'open' && message.inline) {
                if (!probe.__inlineUp) tell('open');
                probe.__inlineUp = true;
                return { opened: true, inline: true };
              }
              if (message.action === 'close') {
                if (probe.__inlineUp) tell('closed');
                probe.__inlineUp = false;
                return { closed: true };
              }
              if (message.action === 'bounds') return { ok: probe.__inlineUp };
              return { opened: true };
            }
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

const roomBox = (page: Page) =>
  page.locator('#layout').evaluate((element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
const historySent = async (page: Page) =>
  (await sent(page, 'history')).map(({ type: _type, ...rest }) => rest);

test('the History tile lays the History view over the room, and says why when there is none', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await open(page, '# %%\nx = 1\n');
  const tile = page.locator('#history-tile');
  // The tile is the one way in on the page (with the shell's ⇧⌘H): no
  // menu item repeats it.
  await expect(page.locator('#open-history')).toHaveCount(0);
  await tile.click();
  const room = await roomBox(page);
  expect(room).toEqual({ x: 44, y: 44, width: 1048, height: 708 });
  await expect.poll(() => historySent(page)).toEqual([{ action: 'open', inline: room }]);
  // Opened: the view is the answer, the tile pressed by the shell's word,
  // nothing to say here.
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(300);
  await expect(page.locator('#toast')).toBeHidden();
  // The Recent menu opens down over the room, under the view: its tile
  // puts the view away first, and the History tile lays it again.
  await page.locator('#recent-tile').click();
  await expect(page.locator('#tb-menu-recent')).toBeVisible();
  await expect.poll(() => historySent(page)).toEqual([{ action: 'open', inline: room }, { action: 'close' }]);
  await expect(tile).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await tile.click();
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  expect((await historySent(page)).at(-1)).toEqual({ action: 'open', inline: room });

  // A shell that answers why, in the folder rule's words: no view.
  await page.evaluate(() => {
    const probe = window as unknown as ProbeWindow;
    probe.__fire('history', { kind: 'inline', state: 'closed' });
    probe.__inlineUp = false;
    probe.__historyAnswer = { reason: 'refused', detail: '~/Desktop itself is never recorded' };
  });
  await tile.click();
  await expect(page.locator('#toast')).toHaveText('No history here: ~/Desktop itself is never recorded');
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute('aria-pressed', 'false');

  // An older shell has no view: said, and then the tile goes.
  await page.evaluate(() => {
    (window as unknown as ProbeWindow).__historyAnswer = null;
  });
  await tile.click();
  await expect(page.locator('#toast')).toHaveText('This Knuth.app has no history view: a newer shell brings it');
  await expect(tile).toBeHidden();
});

type Box = { left: number; top: number; right: number; bottom: number };
/** The bar's boxes, by id (the tile's glyph as `glyph`). */
const bar = (page: Page) =>
  page.evaluate(() => {
    const at = (element: Element | null): Box | null => {
      if (!element || !element.getClientRects().length) return null;
      const r = element.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const ids = ['toolbar', 'open-tile', 'new-window', 'doc-pod', 'file-name', 'doc-mark', 'doc-folder', 'history-tile', 'session-pill', 'kernel-status', 'layout'];
    return {
      ...Object.fromEntries(ids.map((id) => [id, at(document.getElementById(id))])),
      glyph: at(document.querySelector('#history-tile svg')),
    } as Record<string, Box | null>;
  });

test('the History tile is the name pill\'s last child, at its far right, and moves nothing outside the pill', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await open(page, '# %%\nx = 1\n');
  const tile = page.locator('#history-tile');
  await expect(tile).toBeVisible();
  await expect(page.locator('#doc-pod > #history-tile:last-child')).toHaveCount(1);
  const after = await bar(page);
  const pod = after['doc-pod']!;
  const box = after['history-tile']!;
  // Inside the pill, after the folder with the pill's 9 px gap, reaching
  // 6 px into its 10 px padding (so 5 px in from its edge, the 1 px border
  // included); 24 × 24, centred in the 30 px pill (7 px under the 44 px
  // bar's top, so 10 px).
  expect(box.left).toBe(after['doc-folder']!.right + 9);
  expect(box.right).toBe(pod.right - 5);
  expect({ width: box.right - box.left, top: box.top, bottom: box.bottom }).toEqual({ width: 24, top: 10, bottom: 34 });
  // The glyph is 16 px, centred in it.
  expect(after.glyph).toEqual({ left: box.left + 4, top: 14, right: box.left + 20, bottom: 30 });
  // The frame spec's numbers (frame.spec.ts), unchanged: the Open tile 6 px
  // in (a tab has no lights' room), the pill after New window with the
  // bar's gap, 30 px tall; the session pill's right edge on the room's.
  expect(after['open-tile']).toEqual({ left: 6, top: 6, right: 38, bottom: 38 });
  expect(pod.left).toBe(after['new-window']!.right + 6);
  expect(pod.bottom - pod.top).toBe(30);
  expect(after['toolbar']).toEqual({ left: 0, top: 0, right: 1100, bottom: 44 });
  expect(after['layout']).toEqual({ left: 44, top: 44, right: 1092, bottom: 752 });
  expect(after['session-pill']!.right).toBe(1092);
  // And every other box in the bar is where it was without the tile: the
  // pill only grew at its right, by the tile's 24 px and a gap less the
  // 6 px it reaches into the padding.
  await tile.evaluate((element) => { (element as HTMLElement).hidden = true; });
  const before = await bar(page);
  await tile.evaluate((element) => { (element as HTMLElement).hidden = false; });
  expect(before['history-tile']).toBeNull();
  expect(pod.right).toBe(before['doc-pod']!.right + 27);
  expect({ ...pod, right: 0 }).toEqual({ ...before['doc-pod']!, right: 0 });
  const others = (boxes: Record<string, Box | null>) =>
    Object.fromEntries(Object.entries(boxes).filter(([id]) => id !== 'history-tile' && id !== 'glyph' && id !== 'doc-pod'));
  expect(others(after)).toEqual(others(before));

  // A small tile of the bar's family: the New window tile's ink and
  // resting background, at 24 px with 6 px corners and a 16 px glyph.
  const look = (selector: string) =>
    page.locator(selector).evaluate((element) => {
      const style = getComputedStyle(element);
      const glyph = element.querySelector('svg')!.getBoundingClientRect();
      return {
        width: style.width, height: style.height, radius: style.borderRadius, color: style.color,
        background: style.backgroundColor, glyph: [glyph.width, glyph.height],
      };
    });
  await page.mouse.move(600, 400);
  const history = await look('#history-tile');
  const newWindow = await look('#new-window');
  expect({ color: history.color, background: history.background }).toEqual({ color: newWindow.color, background: newWindow.background });
  expect(history).toMatchObject({ width: '24px', height: '24px', radius: '6px', glyph: [16, 16] });
  // The glyph: the standard history icon, a clock face with a
  // counter-clockwise arrow round its left side — the one string Plass's
  // bar draws too (HISTORY_GLYPH in both apps; Plass's frame.spec holds it
  // as well). Its hands keep it apart from the Restart session tile's arrow
  // round a circle, which shares the window.
  const svgs = await page.evaluate(() => [
    document.querySelector('#history-tile svg')!.outerHTML,
    document.querySelector('#restart svg')!.innerHTML,
  ]);
  expect(svgs[0]).toBe(
    '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12a8 8 0 1 1 2.34 5.66M2.2 9.8 5 12.6l2.8-2.8"></path><polyline points="13 7.5 13 12 16.5 14"></polyline></svg>',
  );
  expect(svgs[0]).not.toContain(svgs[1]);
  // Named for a screen reader, its key said in the tooltip; the caption,
  // below it in the frame's dark glass, is the word, as the bar tiles' are.
  await expect(tile).toHaveAttribute('aria-label', 'History');
  await expect(tile).toHaveAttribute('title', 'History (⇧⌘H)');
  await expect(tile).toHaveAttribute('aria-keyshortcuts', 'Shift+Meta+H');
  await expect(tile).toHaveAccessibleName('History');
  await tile.hover();
  const caption = tile.locator('.lbl');
  await expect(caption).toHaveText('History');
  await expect.poll(() => caption.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
  const captionBox = await caption.evaluate((element) => {
    const r = element.getBoundingClientRect();
    return { top: r.top, middle: (r.left + r.right) / 2 };
  });
  expect(captionBox).toEqual({ top: box.bottom + 6, middle: (box.left + box.right) / 2 });
  // The bar is the window's drag region in the shell; the tile is not (its
  // pill is the page's, and the tile within it).
  expect(await tile.evaluate((element) => {
    for (let at: Element | null = element; at; at = at.parentElement) {
      const style = getComputedStyle(at) as CSSStyleDeclaration & { appRegion?: string };
      const region = style.getPropertyValue('-webkit-app-region') || style.appRegion || 'none';
      if (region !== 'none') return region;
    }
    return 'none';
  })).toBe('no-drag');
});

test('the History tile toggles the view over the room, pressed by the shell\'s word only, and goes after an older shell\'s null', async ({ page }) => {
  await open(page, '# %%\nx = 1\n');
  const tile = page.locator('#history-tile');
  const cell = page.locator('.cell .cm-content').first();
  const room = await roomBox(page);
  await expect(tile).toHaveAttribute('aria-pressed', 'false');
  // Typing in a cell: a click on the tile asks for the view over the
  // room's box, and the tile is pressed when the shell says it is up.
  await cell.click();
  await tile.click();
  await expect.poll(() => historySent(page)).toEqual([{ action: 'open', inline: room }]);
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  // The pressed look is the bar's lit tile, the File tile's with its menu.
  await page.mouse.move(600, 400);
  await expect.poll(() => tile.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(46, 46, 50)');
  await expect.poll(() => tile.evaluate((element) => getComputedStyle(element).color)).toBe('rgb(255, 255, 255)');
  // Under the view nothing holds the focus: a key pressed here edits no
  // hidden cell.
  expect(await page.evaluate(() => document.getElementById('layout')!.contains(document.activeElement))).toBe(false);
  await page.waitForTimeout(300);
  await expect(page.locator('#toast')).toBeHidden();
  // Again: `close`, un-pressed when the shell says it went, and the cell
  // has the focus back.
  await tile.click();
  await expect.poll(() => historySent(page)).toEqual([{ action: 'open', inline: room }, { action: 'close' }]);
  await expect(tile).toHaveAttribute('aria-pressed', 'false');
  await expect(cell).toBeFocused();
  // From the keyboard, the same toggle.
  await tile.focus();
  await page.keyboard.press('Enter');
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Enter');
  await expect(tile).toHaveAttribute('aria-pressed', 'false');
  expect(await historySent(page)).toHaveLength(4);

  // The click alone never presses it: a shell that answers but lays no
  // view (it said nothing) leaves it as it was; the shell's word presses
  // it and un-presses it whoever moved the view (Escape in the view, its
  // close tile, the window's page).
  await page.evaluate(() => {
    (window as unknown as ProbeWindow).__historyAnswer = { opened: true, inline: true };
  });
  await tile.click();
  await page.waitForTimeout(300);
  await expect(tile).toHaveAttribute('aria-pressed', 'false');
  await fire(page, 'history', { kind: 'inline', state: 'open' });
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  await fire(page, 'history', { kind: 'inline', state: 'closed' });
  await expect(tile).toHaveAttribute('aria-pressed', 'false');

  // An older shell answers null: the toast says so, as the menu item's
  // does, and the tile and the item go.
  await page.evaluate(() => {
    (window as unknown as ProbeWindow).__historyAnswer = null;
  });
  await tile.click();
  await expect(page.locator('#toast')).toHaveText('This Knuth.app has no history view: a newer shell brings it');
  await expect(tile).toBeHidden();
  await expect(page.locator('#open-history')).toHaveCount(0);
  expect(await historySent(page)).toHaveLength(6);
});

test('View › History… is the shell\'s toggle: the page does what its tile does', async ({ page }) => {
  await open(page, '# %%\nx = 1\n');
  const tile = page.locator('#history-tile');
  await fire(page, 'history', { kind: 'toggle' });
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  expect(await historySent(page)).toEqual([{ action: 'open', inline: await roomBox(page) }]);
  await fire(page, 'history', { kind: 'toggle' });
  await expect(tile).toHaveAttribute('aria-pressed', 'false');
  expect((await historySent(page)).at(-1)).toEqual({ action: 'close' });
  // The shell's other History events are not the document page's.
  await fire(page, 'history', { kind: 'commit', commits: [] });
  await fire(page, 'history', { kind: 'focus', at: SHA });
  await page.waitForTimeout(200);
  expect(await historySent(page)).toHaveLength(2);
});

test('the view follows the room: bounds on a resize and when the scroll rail\'s gutter comes, none while it is down', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await open(page, '# %%\nx = 1\n');
  const tile = page.locator('#history-tile');
  // Down: a resize sends nothing.
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.waitForTimeout(200);
  expect(await historySent(page)).toEqual([]);
  await tile.click();
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  expect(await historySent(page)).toEqual([{ action: 'open', inline: { x: 44, y: 44, width: 1128, height: 748 } }]);
  // A resize: one `bounds`, the room's new box.
  await page.setViewportSize({ width: 1240, height: 820 });
  await expect.poll(() => historySent(page)).toEqual([
    { action: 'open', inline: { x: 44, y: 44, width: 1128, height: 748 } },
    { action: 'bounds', inline: { x: 44, y: 44, width: 1188, height: 768 } },
  ]);
  expect(await roomBox(page)).toEqual({ x: 44, y: 44, width: 1188, height: 768 });

  // A rewind under the view makes the document long: the scroll rail's
  // gutter comes, the room 12 px narrower, and the view goes with it.
  await fire(page, 'save', { id: 's', reason: 'rewind' });
  const long = Array.from({ length: 40 }, (_, i) => `# %%\nv${i + 1} = ${i + 1}\n`).join('\n');
  await page.evaluate(({ path, text }) => {
    (window as unknown as ProbeWindow).__disk[path] = { text, modified: 50_000 };
  }, { path: DOC, text: long });
  await fire(page, 'reload', { id: 'r', paths: ['/private' + DOC], reason: 'rewind', to: SHA });
  await expect(page.locator('#sheet > .cell-wrap')).toHaveCount(40);
  await expect(page.locator('html')).toHaveClass(/has-rail/);
  await expect.poll(async () => (await historySent(page)).at(-1)).toEqual({ action: 'bounds', inline: { x: 44, y: 44, width: 1176, height: 768 } });
  expect(await roomBox(page)).toEqual({ x: 44, y: 44, width: 1176, height: 768 });
  // Put away: a resize sends nothing again.
  await tile.click();
  await expect(tile).toHaveAttribute('aria-pressed', 'false');
  const count = (await historySent(page)).length;
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.waitForTimeout(300);
  expect(await historySent(page)).toHaveLength(count);
});

test('whatever acts in the room puts the view away first; the bar\'s Escape does too', async ({ page }) => {
  await open(page, '# %%\nx = 1\n');
  const tile = page.locator('#history-tile');
  const up = async () => {
    await tile.click();
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
  };
  const closes = async () => {
    await expect(tile).toHaveAttribute('aria-pressed', 'false');
    expect((await historySent(page)).at(-1)).toEqual({ action: 'close' });
  };
  // A pill chip (the Session column would open under the view).
  await up();
  await page.locator('#session-pill .sp-chip[data-part="session"]').click();
  await closes();
  await expect(page.locator('#session')).toBeVisible();
  await page.locator('#session-pill .sp-chip[data-part="session"]').click();
  // The session pill.
  await up();
  await page.locator('#session-pill .sp-chip[data-part="session"]').click();
  await closes();
  await page.keyboard.press('Escape');
  // Escape with the page's focus (on the bar), as Escape in the view.
  await up();
  await tile.focus();
  await page.keyboard.press('Escape');
  await closes();
  // The name pill's rename keeps its own Escape.
  await up();
  const before = (await historySent(page)).length;
  await page.locator('#file-name').click();
  await expect(page.locator('#file-name input')).toBeFocused();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  expect(await historySent(page)).toHaveLength(before);
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
});

test('the document under the view answers a rewind\'s save and reload, and the view stays up', async ({ page }) => {
  await open(page, '# %%\nx = 1\n');
  const tile = page.locator('#history-tile');
  await tile.click();
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  await fire(page, 'save', { id: 'under', reason: 'rewind' });
  await expect.poll(() => sent(page, 'saved')).toEqual([{ type: 'saved', id: 'under', ok: true }]);
  await page.evaluate((path) => {
    (window as unknown as ProbeWindow).__disk[path] = { text: '# %%\nx = "rewound"\n', modified: 60_000 };
  }, DOC);
  await fire(page, 'reload', { id: 'r', paths: ['/private' + DOC], reason: 'rewind', to: SHA });
  await expect(page.locator('#sheet > .cell-wrap').first()).toContainText('x = "rewound"');
  await expect(page.locator('#sheet .cell.stale')).toHaveCount(1);
  expect(await historySent(page)).toEqual([{ action: 'open', inline: await roomBox(page) }]);
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
});

test('when the bar is short the name pill gives way, its folder first; the History tile and Save never do, nor leave the pill', async ({ page }) => {
  const root = '/Users/someone/Library/CloudStorage/Dropbox/Research/econ/2026/wages-and-hours/drafts/chapter-three/analysis';
  const pill = () =>
    page.evaluate(() => {
      const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      const name = document.getElementById('file-name')!;
      const folder = document.getElementById('doc-folder')!;
      const pod = rect('doc-pod');
      // The pill's content box: inside its 1 px border and 10 px padding,
      // the tile reaching 6 px into the padding at the right.
      const inner = { left: pod.left + 11, right: pod.right - 5 };
      const shown = [...document.getElementById('doc-pod')!.children].filter((child) => child.getClientRects().length);
      const at = (child: Element) => child.getBoundingClientRect();
      return {
        width: pod.width,
        nameWhole: name.scrollWidth <= name.clientWidth,
        folderCut: folder.scrollWidth > folder.clientWidth,
        order: shown.map((child) => child.id),
        // Every shown child inside the pill, each clear of the one before
        // by the pill's 9 px gap.
        inside: shown.every((child) => at(child).left >= inner.left - 0.5 && at(child).right <= inner.right + 0.5),
        spaced: shown.every((child, i) => i === 0 || at(child).left >= at(shown[i - 1]!).right + 8.5),
        tileRight: rect('history-tile').right,
        tileWidth: rect('history-tile').width,
        podRight: pod.right,
        session: { left: rect('session-pill').left, right: rect('session-pill').right },
      };
    });
  for (const width of [1100, 780]) {
    await page.setViewportSize({ width, height: 760 });
    await open(page, '# %%\nx = 1\n', `${root}/wages-and-hours.py`);
    const at = await pill();
    // The pill at its max-width, min(560px, 50vw), its folder cut; the
    // tile whole at its far right, the pill clear of the session pill.
    expect(at.width, `at ${width}`).toBe(Math.min(560, width / 2));
    expect(at, `at ${width}`).toMatchObject({ nameWhole: true, folderCut: true, inside: true, spaced: true, tileWidth: 24 });
    expect(at.order).toEqual(['file-name', 'doc-mark', 'doc-folder', 'history-tile']);
    expect(at.tileRight).toBe(at.podRight - 5);
    expect(at.podRight + 6).toBeLessThanOrEqual(at.session.left);
    expect(at.session.right).toBe(width - 8);
  }
  // Autosave off: Save shows, before the tile; with a long name, at the
  // narrowest bar that still shows a folder, the name leaves both their
  // room — it takes an ellipsis rather than push anything out of the pill.
  const name = `${'a-long-document-name-'.repeat(3)}draft.py`;
  await page.setViewportSize({ width: 760, height: 760 });
  await open(page, '# %%\nx = 1\n', `${root}/${name}`);
  await page.locator('#recent-tile').click();
  await page.locator('#tb-menu-recent').getByRole('menuitemcheckbox', { name: 'Autosave' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#doc-save')).toBeVisible();
  const at = await pill();
  expect(at.width).toBe(380);
  expect(at).toMatchObject({ nameWhole: false, inside: true, spaced: true, tileWidth: 24 });
  expect(at.order).toEqual(['file-name', 'doc-mark', 'doc-folder', 'doc-save', 'history-tile']);
  expect(at.tileRight).toBe(at.podRight - 5);
});

test('a plain tab has no History item and no History tile', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { claerbout?: unknown }).claerbout;
  });
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(page.locator('#history-tile')).toBeHidden();
  await expect(page.locator('#open-tile')).toBeVisible();
  await expect(page.locator('#open-history')).toHaveCount(0);
  // The pill where it always was, after New window.
  const pod = await page.locator('#doc-pod').evaluate((element) => element.getBoundingClientRect().left);
  const after = await page.locator('#new-window').evaluate((element) => element.getBoundingClientRect().right);
  expect(pod).toBe(after + 6);
});
