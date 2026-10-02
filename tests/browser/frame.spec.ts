// The frame (src/styles.css, "the bar", "the rail", "the room"): Zen's
// shape, with Plass's values (plass/tests/frame.spec.ts). A dark grey
// frame — the bar across the top, the rail down the left, an 8 px edge
// round the rest — holds the room, a rounded panel where the document
// column keeps its width and centres. The bar is the window's title bar in
// Knuth.app, so its empty part is a drag region and its controls are not;
// the zoom step and the traffic lights themselves are the shell's
// (claerbout/smoke.mjs checks the overlay), which a tab cannot show.
import { expect, test, type Page } from '@playwright/test';

type Probe = typeof window & { __knuthRefuseConnections?: boolean };

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
          if ((window as Probe).__knuthRefuseConnections && !this.url.includes('/@vite')) {
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
          this.reply({ type: 'attached', protocol: msg.protocol, session: msg.session, resumed: false });
          this.reply({ type: 'ready' });
        } else if (msg.type === 'namespace') {
          this.reply({ type: 'namespace', id: msg.id, vars: [] });
        } else if (msg.type === 'run') {
          this.reply({ type: 'done', id: msg.id, result: null });
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

async function boot(page: Page, width = 1100, height = 760) {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');
}

type Box = { left: number; top: number; right: number; bottom: number };
const box = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((element): Box => {
    const r = element.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });

/** The app region that decides a click on the element: its own, or that of
 *  the nearest ancestor that sets one (the shell's drag regions are boxes,
 *  and a control inside a no-drag box is the page's). */
const appRegion = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((element) => {
    for (let at: Element | null = element; at; at = at.parentElement) {
      const style = getComputedStyle(at) as CSSStyleDeclaration & { appRegion?: string };
      const region = style.getPropertyValue('-webkit-app-region') || style.appRegion || 'none';
      if (region !== 'none') return region;
    }
    return 'none';
  });

test('the frame is Zen\'s: a dark edge all round a rounded room, a 48 px rail, the bar a drag region with its controls the page\'s', async ({ page }) => {
  await boot(page);
  const look = await page.evaluate(() => {
    const layout = document.getElementById('layout')!;
    return {
      frame: getComputedStyle(document.body).backgroundColor,
      room: getComputedStyle(layout).backgroundColor,
      radius: getComputedStyle(layout).borderRadius,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
  // A dark grey frame, not black, and the room the graphite it always was.
  expect(look.frame).toBe('rgb(24, 24, 26)');
  expect(look.room).toBe('rgb(43, 42, 45)');
  expect(look.radius).toBe('12px');

  // The bar spans the window (its title bar, in Knuth.app); the rail runs
  // under it down the left edge, 32 px tiles with the frame's 8 px either
  // side; the room starts where they end and keeps the same 8 px to the
  // window's right and bottom. The first tile is level with the room's top
  // edge, the view switch with its bottom.
  const bar = await box(page, '#toolbar');
  expect(bar.left).toBe(0);
  expect(bar.right).toBe(look.width);
  expect(bar.bottom).toBe(60);
  expect(await box(page, '#rail')).toEqual({ left: 0, top: bar.bottom, right: 48, bottom: look.height });
  const first = await box(page, '#rail .tb-btn');
  expect(first).toEqual({ left: 8, top: bar.bottom, right: 40, bottom: bar.bottom + 32 });
  const room = await box(page, '#layout');
  expect(room).toEqual({ left: 48, top: bar.bottom, right: look.width - 8, bottom: look.height - 8 });
  expect((await box(page, '#view-toggle')).bottom).toBe(room.bottom);
  // The pills are 42 px in the 60 px bar, and the status pill ends where
  // the room does.
  const status = await box(page, '#kernel-status');
  expect(status.bottom - status.top).toBe(42);
  expect(status.right).toBe(room.right);
  expect((await box(page, '#doc-pod')).bottom - (await box(page, '#doc-pod')).top).toBe(42);

  // In a tab there is no lights' room: the File tile stands over the rail's
  // column of tiles.
  const file = await box(page, '#file-tile');
  expect(file.left).toBe(6);
  expect((file.left + file.right) / 2).toBe((first.left + first.right) / 2);

  // Chromium exposes the property (inert in a tab): the shell's window
  // moves by the bar's empty part, and the controls keep their clicks.
  // The rail scrolls, so it is no drag region.
  expect(await appRegion(page, '#toolbar')).toBe('drag');
  expect(await appRegion(page, '#rail')).not.toBe('drag');
  for (const selector of ['#doc-pod', '#file-name', '#file-tile', '.tb-end', '#kernel-status']) {
    expect(await appRegion(page, selector), selector).toBe('no-drag');
  }
  await page.locator('#file-tile').click();
  expect(await appRegion(page, '.tb-flyout')).toBe('no-drag');
  await page.getByTitle('Your documents').click();
  await expect(page.locator('.file-menu')).toBeVisible();
  expect(await appRegion(page, '.file-menu')).toBe('no-drag');
});

test('the controls are where the frame puts them, with every id the tests and the smoke use', async ({ page }) => {
  await boot(page);
  for (const id of ['cells-pod', 'add-code', 'add-scratch', 'add-text', 'run-pod', 'run-stale', 'run-all', 'stop', 'restart', 'toggle-panel', 'view-toggle']) {
    await expect(page.locator(`#rail #${id}`), id).toHaveCount(1);
  }
  for (const id of ['doc-pod', 'file-tile', 'file-name', 'doc-folder', 'install-app', 'update-app', 'get-app', 'kernel-status']) {
    await expect(page.locator(`#toolbar #${id}`), id).toHaveCount(1);
  }
  // The status holds its words and nothing else (the shell's smoke compares
  // its text exactly), and the name its name.
  expect(await page.locator('#kernel-status').evaluate((element) => element.textContent)).toBe('Python');
  await expect(page.locator('#file-name')).toHaveText('Knuth.py');
  // No folder for a document that has none.
  await expect(page.locator('#doc-folder')).toBeHidden();
});

test('the column keeps its width and centres in the room, with the panel shown or hidden', async ({ page }) => {
  const centred = () => page.evaluate(() => {
    const doc = document.getElementById('doc')!;
    const sheet = document.getElementById('sheet')!.getBoundingClientRect();
    const style = getComputedStyle(doc);
    const left = doc.getBoundingClientRect().left + doc.clientLeft + parseFloat(style.paddingLeft);
    const content = doc.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return { width: sheet.width, offset: Math.abs(sheet.left + sheet.width / 2 - (left + content / 2)), content };
  });
  await boot(page, 1500, 900);
  await expect(page.locator('#panel')).toBeVisible();
  const shown = await centred();
  expect(shown.width).toBe(832);
  expect(shown.offset).toBeLessThan(1);
  await page.locator('#toggle-panel').click();
  await expect(page.locator('#panel')).toBeHidden();
  const hidden = await centred();
  expect(hidden.width).toBe(832);
  expect(hidden.offset).toBeLessThan(1);
  // Narrower than the column plus the panel: the column fills what there is.
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.locator('#toggle-panel').click();
  const narrow = await centred();
  expect(narrow.width).toBe(narrow.content);
  // The column starts 24 px under the room's top edge (the bar no longer
  // floats over it).
  expect(await page.locator('#doc').evaluate((element) => getComputedStyle(element).paddingTop)).toBe('24px');
});

test('the session panel\'s tile is lit while the panel shows', async ({ page }) => {
  await boot(page);
  const tile = page.locator('#toggle-panel');
  await expect(page.locator('#panel')).toBeVisible();
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  const lit = await tile.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(lit).toBe('rgb(46, 46, 50)');
  await tile.click();
  await expect(page.locator('#panel')).toBeHidden();
  await expect(tile).toHaveAttribute('aria-pressed', 'false');
  // Remembered, and painted at boot.
  await page.reload();
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(page.locator('#panel')).toBeHidden();
  await expect(tile).toHaveAttribute('aria-pressed', 'false');
});

test('the File tile drops its row below on a click and closes on an item, a click elsewhere or Escape', async ({ page }) => {
  await boot(page);
  const tile = page.locator('#file-tile');
  const drop = page.locator('.tb-flyout');
  await expect(drop).toBeHidden();
  // A hover no longer opens it; a click does, 8 px under the tile.
  await tile.hover();
  await expect(drop).toBeHidden();
  await tile.click();
  await expect(drop).toBeVisible();
  await expect(tile).toHaveAttribute('aria-expanded', 'true');
  expect((await box(page, '.tb-flyout')).top).toBe((await box(page, '#file-tile')).bottom + 8);
  // A click elsewhere closes it.
  await page.locator('#doc').click({ position: { x: 300, y: 600 } });
  await expect(drop).toBeHidden();
  await expect(tile).toHaveAttribute('aria-expanded', 'false');
  // Opened by a click, with the focus in a cell, Escape closes it.
  await page.locator('.cm-content').first().click();
  await tile.click();
  await expect(drop).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drop).toBeHidden();
  // Escape from inside it closes it and hands the focus back to the tile.
  await tile.click();
  await expect(drop).toBeVisible();
  await page.getByTitle('Open… (⌘O)').focus();
  await page.keyboard.press('Escape');
  await expect(drop).toBeHidden();
  await expect(tile).toBeFocused();
  // From the keyboard: ArrowDown opens it on its first item, the arrows
  // walk the row, Tab out closes it.
  await page.keyboard.press('ArrowDown');
  await expect(drop).toBeVisible();
  await expect(page.getByTitle(/^New document/)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTitle('Open… (⌘O)')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTitle('Your documents')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(drop).toBeHidden();
  // An item closes it: Recent opens its list under the tile.
  await tile.click();
  await page.getByTitle('Your documents').click();
  await expect(drop).toBeHidden();
  const menu = page.locator('.file-menu');
  await expect(menu).toBeVisible();
  expect((await box(page, '.file-menu')).top).toBe((await box(page, '#file-tile')).bottom + 10);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('the name pill renames in place and keeps the name\'s text exact', async ({ page }) => {
  await boot(page);
  await page.locator('#file-name').click();
  const input = page.locator('#file-name input.rename');
  await expect(input).toBeFocused();
  await input.fill('wages.py');
  await input.press('Enter');
  await expect(page.locator('#file-name')).toHaveText('wages.py');
  await expect(page).toHaveTitle('wages.py');
  // The bar is a drag region in the shell; the name is not.
  expect(await appRegion(page, '#file-name')).toBe('no-drag');
});

test('source view keeps the frame: the bar and the switch, the room One Dark, no cell tools', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('knuth-doc', JSON.stringify({ name: 'script.py', dirty: false, text: 'print(1)\n# %%\nx = 1\n' }));
  });
  await boot(page);
  // A document with cells opens in cell view; the rail's switch (or ⌘⇧E)
  // goes to its source.
  await expect(page.locator('body')).toHaveAttribute('data-view', '');
  await page.locator('#view-toggle').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'source');
  await expect(page.locator('#toolbar')).toBeVisible();
  await expect(page.locator('#file-name')).toHaveText('script.py');
  for (const gone of ['#cells-pod', '#run-pod', '#rail .tb-rule', '#toggle-panel']) {
    await expect(page.locator(gone), gone).toBeHidden();
  }
  const look = await page.evaluate(() => ({
    room: getComputedStyle(document.getElementById('layout')!).backgroundColor,
    frame: getComputedStyle(document.body).backgroundColor,
  }));
  expect(look.room).toBe('rgb(40, 44, 52)');
  expect(look.frame).toBe('rgb(24, 24, 26)');
  // The switch is lit while the text is the truth (once its fade is over,
  // and with the pointer away from it).
  await page.mouse.move(600, 400);
  await expect.poll(() => page.locator('#view-toggle').evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe('rgb(46, 46, 50)');
  const room = await box(page, '#layout');
  expect((await box(page, '#view-toggle')).bottom).toBe(room.bottom);
});

test('the onboarding covers the room only: the status that opens it stays clickable', async ({ page }) => {
  await page.addInitScript(() => {
    (window as Probe).__knuthRefuseConnections = true;
  });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python engine unavailable');
  const onboarding = page.locator('#onboarding');
  await expect(onboarding).toBeVisible();
  expect(await box(page, '#onboarding')).toEqual(await box(page, '#layout'));
  expect(await onboarding.evaluate((element) => getComputedStyle(element).borderRadius)).toBe('12px');
  await page.locator('.onboarding-dismiss').click();
  await expect(onboarding).toBeHidden();
  await page.locator('#kernel-status').click();
  await expect(onboarding).toBeVisible();
  // The rail is still there to use beside it.
  await expect(page.locator('#run-all')).toBeVisible();
});

test('the toast sits on the room\'s axis', async ({ page }) => {
  await boot(page);
  // A run with no folder attached offers one, in a toast.
  await page.locator('.cell .run').first().click();
  const toast = page.locator('#toast');
  await expect(toast).toBeVisible();
  const at = await box(page, '#toast');
  const room = await box(page, '#layout');
  expect(Math.abs((at.left + at.right) / 2 - (room.left + room.right) / 2)).toBeLessThan(1);
  expect(room.bottom - at.bottom).toBe(12);
});

test('a short window cuts the cell tools under a fade and keeps the panel tile and the switch whole', async ({ page }) => {
  await boot(page);
  const cue = () => page.evaluate(() => {
    const groups = document.querySelector('.tb-rail-groups')!;
    return { above: groups.classList.contains('tb-more-above'), below: groups.classList.contains('tb-more-below') };
  });
  const pinned = () => page.evaluate(() => {
    const groups = document.querySelector('.tb-rail-groups')!;
    const cut = groups.getBoundingClientRect().bottom;
    return ['toggle-panel', 'view-toggle'].map((id) => {
      const tile = document.getElementById(id)!;
      const bounds = tile.getBoundingClientRect();
      return { id, scrolls: groups.contains(tile), belowCut: bounds.top >= cut, inWindow: bounds.bottom <= innerHeight - 8 };
    });
  });
  await expect.poll(cue).toEqual({ above: false, below: false });
  await page.setViewportSize({ width: 1100, height: 360 });
  await expect.poll(cue).toEqual({ above: false, below: true });
  for (const tile of await pinned()) expect(tile).toEqual({ id: tile.id, scrolls: false, belowCut: true, inWindow: true });
  // A tile Tab reaches under the fade scrolls into view, clear of it: the
  // last one, Restart, to the end of the groups, where the fade is gone.
  await page.locator('#stop').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#restart')).toBeFocused();
  await expect.poll(cue).toEqual({ above: true, below: false });
  const inView = await page.evaluate(() => {
    const groups = document.querySelector('.tb-rail-groups')!.getBoundingClientRect();
    const tile = document.getElementById('restart')!.getBoundingClientRect();
    return tile.top >= groups.top - 0.5 && tile.bottom <= groups.bottom + 0.5;
  });
  expect(inView).toBe(true);
});

test('below the layout floor the room scrolls sideways, and the bar and the rail stay put', async ({ page }) => {
  await boot(page, 700, 600);
  const scroll = await page.evaluate(() => {
    const layout = document.getElementById('layout')!;
    return {
      room: layout.scrollWidth > layout.clientWidth,
      page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  expect(scroll).toEqual({ room: true, page: false });
  await page.locator('#layout').evaluate((element) => { element.scrollLeft = 200; });
  expect((await box(page, '#rail .tb-btn')).left).toBe(8);
  expect((await box(page, '#kernel-status')).right).toBe(700 - 8);
});
