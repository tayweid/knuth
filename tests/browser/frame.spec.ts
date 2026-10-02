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
  // The menus drop into the bar's band: theirs, too.
  await page.locator('#file-tile').click();
  expect(await appRegion(page, '#tb-menu-file')).toBe('no-drag');
  await page.getByTitle('Your documents').click();
  await expect(page.locator('#tb-menu-recent')).toBeVisible();
  expect(await appRegion(page, '#tb-menu-recent')).toBe('no-drag');
});

test('the controls are where the frame puts them, with every id the tests and the smoke use', async ({ page }) => {
  await boot(page);
  for (const id of ['cells-pod', 'add-code', 'add-scratch', 'add-text', 'run-pod', 'run-stale', 'run-all', 'stop', 'restart', 'toggle-panel', 'view-toggle']) {
    await expect(page.locator(`#rail #${id}`), id).toHaveCount(1);
  }
  for (const id of ['doc-pod', 'file-tile', 'file-name', 'doc-mark', 'doc-folder', 'kernel-status']) {
    await expect(page.locator(`#toolbar #${id}`), id).toHaveCount(1);
  }
  // Get Knuth, Install and the update are File menu items, as in Plass.
  for (const id of ['get-app', 'install-app', 'update-app']) {
    await expect(page.locator(`#tb-menu-file #${id}`), id).toHaveCount(1);
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

test('the File tile opens Plass\'s text menu under it, and it closes on an item, a click elsewhere or Escape', async ({ page }) => {
  await boot(page);
  const tile = page.locator('#file-tile');
  const file = page.locator('#tb-menu-file');
  await expect(file).toBeHidden();
  // A hover does not open it; a click does, 10 px under the tile and
  // left-aligned with it, on its first item.
  await tile.hover();
  await expect(file).toBeHidden();
  await tile.click();
  await expect(file).toBeVisible();
  await expect(tile).toHaveAttribute('aria-expanded', 'true');
  const at = await box(page, '#tb-menu-file');
  const anchor = await box(page, '#file-tile');
  expect(at.top).toBe(anchor.bottom + 10);
  // (Never closer than 8 px to the window's edge: the tile is 6 px in, in
  // a tab; beside the lights it is the tile's own left.)
  expect(at.left).toBe(Math.max(8, anchor.left));
  // A vertical text menu: New window, Open…, Recent documents ›, Save, in
  // Plass's dark glass. In a locally served tab with no install offered,
  // Get Knuth, Install and the update are away, and so is their rule.
  const items = file.locator('.tb-menu-item:visible');
  await expect(items.locator('.tb-menu-label')).toHaveText(['New window', 'Open…', 'Recent documents', 'Save']);
  await expect(items.locator('kbd')).toHaveText(['⌘O', '›', '⌘S']);
  await expect(file.locator('.tb-menu-divider')).toBeHidden();
  await expect(items.first()).toBeFocused();
  const look = await file.evaluate((element) => {
    const style = getComputedStyle(element);
    return { glass: style.backgroundColor, radius: style.borderRadius, width: element.getBoundingClientRect().width };
  });
  expect(look).toEqual({ glass: 'rgba(27, 26, 30, 0.94)', radius: '13px', width: 258 });
  // A click elsewhere closes it.
  await page.locator('#doc').click({ position: { x: 300, y: 600 } });
  await expect(file).toBeHidden();
  await expect(tile).toHaveAttribute('aria-expanded', 'false');

  // Opened with a click while typing in a cell, Escape closes it and the
  // focus goes back to the cell — Escape never reaches it.
  await page.locator('.cm-content').first().click();
  await tile.click();
  await expect(file).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(file).toBeHidden();
  await expect(page.locator('.cm-content').first()).toBeFocused();

  // From the keyboard: ArrowDown on the tile opens it on its first item;
  // the arrows, Home, End and a letter walk it; ArrowRight opens Recent in
  // its place and ArrowLeft goes back; Escape hands the focus to the tile.
  await tile.focus();
  await page.keyboard.press('ArrowDown');
  await expect(file).toBeVisible();
  await expect(page.getByTitle(/^New document/)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTitle('Open… (⌘O)')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByTitle('Save (⌘S)')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByTitle(/^New document/)).toBeFocused();
  await page.keyboard.press('r');
  await expect(page.getByTitle('Your documents')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const recent = page.locator('#tb-menu-recent');
  await expect(recent).toBeVisible();
  await expect(file).toBeHidden();
  await expect(recent.locator('.tb-menu-heading')).toHaveText('Recent documents');
  await expect(recent).toContainText('Your saved documents will appear here.');
  await expect(recent.getByTitle('Back to File')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(file).toBeVisible();
  await expect(page.getByTitle('Your documents')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(file).toBeHidden();
  await expect(tile).toBeFocused();
  // Tab out of it closes it and goes on from the tile.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await expect(file).toBeHidden();

  // An item closes it and runs: New window opens this page again.
  await tile.click();
  const popup = page.waitForEvent('popup');
  await page.getByTitle(/^New document/).click();
  expect(new URL((await popup).url()).pathname).toBe('/');
  await expect(file).toBeHidden();
  // A second click on the tile closes it.
  await tile.click();
  await expect(file).toBeVisible();
  await tile.click();
  await expect(file).toBeHidden();
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

/** Stash a document the way a reload restores it, by path. */
async function stash(page: Page, path: string, dirty: boolean) {
  await page.addInitScript(([where, unsaved]) => {
    sessionStorage.setItem('knuth-doc', JSON.stringify({
      name: where.split('/').pop(),
      dirty: unsaved,
      text: '# %%\nx = 1\n',
      path: where,
      root: where.slice(0, where.lastIndexOf('/')),
    }));
  }, [path, dirty] as const);
}

const markColour = (page: Page) => page.locator('#doc-mark').evaluate((element) => getComputedStyle(element).backgroundColor);

test('the save mark is Plass\'s: green when the file holds the document, red when it does not', async ({ page }) => {
  await stash(page, '/Users/someone/Projects/week-3/wages.py', false);
  await boot(page);
  await expect(page.locator('#doc-pod')).toHaveClass(/doc-saved/);
  await expect.poll(() => markColour(page)).toBe('rgba(110, 165, 118, 0.9)');
  expect(await page.locator('#doc-mark').evaluate((element) => element.getBoundingClientRect().width)).toBe(6);
  // An edit: red until the autosave lands.
  await page.locator('.cm-content').first().click();
  await page.keyboard.type('2');
  await expect(page.locator('#doc-pod')).toHaveClass(/doc-unsaved/);
  await expect.poll(() => markColour(page)).toBe('rgba(205, 100, 82, 0.95)');
});

test('a new document with no file yet is unsaved', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#doc-pod')).toHaveClass(/doc-unsaved/);
  await expect(page.locator('#doc-mark')).toHaveAttribute('title', /⌘S picks its folder/);
});

test('a long folder gives way from its start; the name and the save mark never do', async ({ page }) => {
  const root = '/Users/someone/Library/CloudStorage/Dropbox/Research/econ/2026/wages-and-hours/drafts/chapter-three/analysis';
  await stash(page, `${root}/wages-and-hours.py`, true);
  for (const width of [1100, 780]) {
    await boot(page, width);
    const pill = await page.evaluate(() => {
      const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      const name = document.getElementById('file-name')!;
      const folder = document.getElementById('doc-folder')!;
      const path = folder.firstElementChild!.getBoundingClientRect();
      return {
        nameWhole: name.scrollWidth <= name.clientWidth,
        markInside: rect('doc-mark').left >= rect('file-name').right && rect('doc-mark').right <= rect('doc-pod').right,
        markWidth: rect('doc-mark').width,
        folderCut: folder.scrollWidth > folder.clientWidth,
        // The path's head is cut, its end (the nearest folder) shows.
        headCut: path.left < rect('doc-folder').left,
        endShows: path.right <= rect('doc-folder').right + 0.5,
        text: folder.textContent,
        title: folder.title,
        clear: rect('doc-pod').right <= rect('kernel-status').left,
      };
    });
    expect(pill, `at ${width}`).toEqual({
      nameWhole: true,
      markInside: true,
      markWidth: 6,
      folderCut: true,
      headCut: true,
      endShows: true,
      text: root.replace('/Users/someone', '~'),
      title: root,
      clear: true,
    });
    await expect(page.locator('#file-name')).toHaveText('wages-and-hours.py');
  }
});

test('the folder\'s ~ is a person\'s home, not /Users/Shared', async ({ page }) => {
  await stash(page, '/Users/Shared/Projects/week-3/wages.py', false);
  await boot(page);
  await expect(page.locator('#doc-folder')).toHaveText('/Users/Shared/Projects/week-3');
});

test('source view keeps the frame: the bar and the switch lit, the room One Dark, the cell tools resting', async ({ page }) => {
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
  // Plass's rule: the tools that cannot act here rest, dim, in their
  // places — the rail reads as the rail in every view.
  await expect(page.locator('#rail .tb-rule')).toBeVisible();
  for (const id of ['add-code', 'add-scratch', 'add-text', 'run-stale', 'run-all', 'stop', 'restart', 'toggle-panel']) {
    const tile = page.locator(`#${id}`);
    await expect(tile, id).toBeVisible();
    await expect(tile, id).toHaveAttribute('aria-disabled', 'true');
    expect(await tile.evaluate((element) => getComputedStyle(element).opacity), id).toBe('0.4');
  }
  // A click on a resting tile does nothing (forced: Playwright itself
  // waits for an aria-disabled control to wake).
  await page.locator('#toggle-panel').click({ force: true });
  await expect(page.locator('#toggle-panel')).toHaveAttribute('aria-pressed', 'true');
  const look = await page.evaluate(() => ({
    room: getComputedStyle(document.getElementById('layout')!).backgroundColor,
    frame: getComputedStyle(document.body).backgroundColor,
  }));
  expect(look.room).toBe('rgb(40, 44, 52)');
  expect(look.frame).toBe('rgb(24, 24, 26)');
  // The switch is lit while the text is the truth (once its fade is over,
  // and with the pointer away from it), and is not resting.
  await expect(page.locator('#view-toggle')).not.toHaveAttribute('aria-disabled', 'true');
  await page.mouse.move(600, 400);
  await expect.poll(() => page.locator('#view-toggle').evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe('rgb(46, 46, 50)');
  const room = await box(page, '#layout');
  expect((await box(page, '#view-toggle')).bottom).toBe(room.bottom);
  // Back in cell view, the tools wake.
  await page.locator('#view-toggle').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', '');
  await expect(page.locator('#add-code')).not.toHaveAttribute('aria-disabled', 'true');
});

test('a script with no cells keeps a whole rail, every tile resting, the switch too', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('knuth-doc', JSON.stringify({ name: 'plain.py', dirty: false, text: 'print(1)\n' }));
  });
  await boot(page);
  await expect(page.locator('body')).toHaveAttribute('data-view', 'source');
  const tiles = page.locator('#rail .tb-btn');
  await expect(tiles).toHaveCount(9);
  for (const tile of await tiles.all()) {
    await expect(tile).toBeVisible();
    await expect(tile).toHaveAttribute('aria-disabled', 'true');
  }
  await expect(page.locator('#view-toggle')).toHaveAttribute('title', /no # %% cells/);
  // The switch and the code-cell tile are two glyphs, not <> twice.
  const glyphs = await page.evaluate(() => [
    document.querySelector('#add-code svg')!.innerHTML,
    document.querySelector('#view-toggle svg')!.innerHTML,
  ]);
  expect(glyphs[0]).not.toBe(glyphs[1]);
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

test('the floor is main\'s: with the panel shown the room fits a 990 px window and scrolls sideways below it', async ({ page }) => {
  const sideways = () => page.locator('#layout').evaluate((element) => element.scrollWidth > element.clientWidth);
  await boot(page, 990, 700);
  await expect(page.locator('#panel')).toBeVisible();
  expect(await sideways()).toBe(false);
  // The column at the floor.
  expect(await page.locator('#sheet').evaluate((element) => element.getBoundingClientRect().width)).toBe(544);
  await page.setViewportSize({ width: 989, height: 700 });
  await expect.poll(sideways).toBe(true);
  // Without the panel, 640, as before the frame.
  await page.locator('#toggle-panel').click();
  await page.setViewportSize({ width: 640, height: 700 });
  await expect.poll(sideways).toBe(false);
  await page.setViewportSize({ width: 639, height: 700 });
  await expect.poll(sideways).toBe(true);
});
