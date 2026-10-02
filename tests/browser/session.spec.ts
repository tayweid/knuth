// The session (src/session.ts, docs/SESSION.md): a run's receipt beside the
// cell that flies up into the pill, the chip it leaves at the cell's corner,
// and the Session card from the pill — floating, docked beside the column
// (which slides left for it), its three modes and its Data and Figures tabs. The mock engine answers a run the way the real
// one does: a done event whose `bound` lists what the cell assigned, a
// figures event for a cell that plots, and a namespace that keeps them.
import { expect, test, type Locator, type Page } from '@playwright/test';

type Probe = typeof window & { __knuthTableRequests?: Array<Record<string, unknown>>; __knuthRuns?: number };

const FIGURE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140" viewBox="0 0 240 140"><rect width="240" height="140" fill="#fff"/><path d="M20 30 L120 80 L220 115" fill="none" stroke="#305c8a" stroke-width="3"/></svg>';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((figureSvg) => {
    // What the engine's Session.bound would say about the names these
    // documents assign; anything else is an int with its literal preview.
    const KINDS: Record<string, Record<string, unknown>> = {
      prices: { type: 'DataFrame', shape: [250, 2], preview: '     price  quantity\n0   0.5  812' },
      demand: { type: 'Series', length: 3, preview: 'price 0.5 812.0 1.0 410.0 1.5 190.0' },
      elasticity: { type: 'Series', length: 3, preview: 'price 0.5 NaN 1.0 -0.495 1.5 -1.073' },
      ax: { type: 'Axes', preview: "<Axes: xlabel='price'>", figure: true },
      tmp: { type: 'Series', length: 3, preview: 'price 0.5 NaN', scratch: true },
    };
    class MockWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      private ns = new Map<string, Record<string, unknown>>();

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
        const probe = window as Probe;
        if (msg.type === 'attach') {
          this.reply({ type: 'attached', protocol: msg.protocol, session: msg.session, resumed: false });
          this.reply({ type: 'ready' });
        } else if (msg.type === 'restart') {
          this.ns.clear();
          this.reply({ type: 'ready', id: msg.id });
        } else if (msg.type === 'run') {
          probe.__knuthRuns = (probe.__knuthRuns ?? 0) + 1;
          const bound: Array<Record<string, unknown>> = [];
          for (const line of String(msg.code).split('\n')) {
            // A change in place binds nothing the AST can see; the
            // namespace still changes.
            const inPlace = /^(\w+)\[/.exec(line.trim());
            const held = inPlace && this.ns.get(inPlace[1]);
            if (held) this.ns.set(inPlace![1], { ...held, shape: [250, 3], preview: `${held.preview} (+1 col)` });
            const match = /^(\w+)\s*=\s*(.*)$/.exec(line.trim());
            if (!match) continue;
            const [, name, value] = match;
            const entry = { name, ...(KINDS[name] ?? { type: 'int', preview: value, saved: true }) } as Record<string, unknown>;
            if (msg.scratch) entry.scratch = true;
            this.ns.set(name, entry);
            bound.push(entry);
          }
          if (String(msg.code).includes('.plot(')) {
            this.reply({ type: 'figures', id: msg.id, svgs: [figureSvg], named: ['ax'] });
          }
          window.setTimeout(() => this.reply({ type: 'done', id: msg.id, result: null, bound }), 30);
        } else if (msg.type === 'namespace') {
          const vars = [...this.ns.values()].map(({ saved: _saved, ...entry }) => entry);
          this.reply({ type: 'namespace', id: msg.id, vars });
        } else if (msg.type === 'table') {
          (probe.__knuthTableRequests ??= []).push(msg);
          const offset = Number(msg.offset ?? 0);
          const limit = Math.min(Number(msg.limit ?? 100), 250 - offset);
          const rows = Array.from({ length: limit }, (_, i) => [String((offset + i) % 3 * 0.5 + 0.5), String(800 - offset - i)]);
          this.reply({
            type: 'table', id: msg.id, name: msg.name, columns: ['price', 'quantity'],
            index: rows.map((_, i) => String(offset + i)), rows, total_rows: 250, total_cols: 2, offset,
          });
        } else if (msg.type === 'figure') {
          this.reply({ type: 'figure', id: msg.id, name: msg.name, svg: figureSvg });
        } else if (msg.type === 'artifacts') {
          this.reply({ type: 'artifacts', id: msg.id, values: {}, figures: {} });
        }
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close'));
      }

      private reply(message: object) {
        window.setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  }, FIGURE_SVG);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('knuth-doc')) return;
    sessionStorage.setItem('knuth-doc', JSON.stringify({
      name: 'demand.py',
      dirty: false,
      text: [
        '# %%',
        'prices = read_csv("prices.csv")',
        'n = 1200',
        '',
        '# %%',
        'demand = prices.groupby("price").quantity.median()',
        'elasticity = demand.pct_change()',
        'ax = demand.plot(marker="o")',
        '',
        '# %% scratch',
        'tmp = elasticity.round(3)',
        '',
        '# %%',
        'k = 3',
        '',
      ].join('\n'),
    }));
  });
});

type Box = { left: number; top: number; right: number; bottom: number; width: number };
const boxOf = (locator: Locator) =>
  locator.first().evaluate((element): Box => {
    const r = element.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width };
  });
const box = (page: Page, selector: string) => boxOf(page.locator(selector));

/** The room, the doc's content box, the column and the cards, at once. */
const layout = (page: Page) => page.evaluate(() => {
  const rect = (id: string) => {
    const r = document.getElementById(id)!.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width };
  };
  const doc = document.getElementById('doc')!;
  const style = getComputedStyle(doc);
  const room = document.getElementById('layout')!;
  return {
    room: rect('layout'),
    sheet: rect('sheet'),
    receipt: rect('receipt'),
    session: rect('session'),
    contentLeft: doc.getBoundingClientRect().left + parseFloat(style.paddingLeft),
    content: doc.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    sideways: room.scrollWidth > room.clientWidth,
  };
});

/** Where the column stands when nothing beside it asks for room: centred. */
const centredLeft = (g: { contentLeft: number; content: number; sheet: { width: number } }) =>
  g.contentLeft + Math.max(0, (g.content - g.sheet.width) / 2);

async function boot(page: Page, width = 1500, height = 940) {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(page.locator('#session-pill .sp-names')).toHaveText('empty session');
}

const cell = (page: Page, i: number) => page.locator('#sheet .cell-wrap').nth(i);
const pillNames = (page: Page) => page.locator('#session-pill .sp-names span:not(.sp-more):visible');

async function run(page: Page, i: number) {
  await cell(page, i).locator('.run').click();
}

/** Run a cell, wait for its receipt, and put it away (Esc). */
async function runAndFile(page: Page, i: number) {
  await run(page, i);
  await expect(page.locator('#receipt')).toHaveAttribute('data-cell', /c\d+/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#receipt')).toBeHidden();
}

test('a run leaves its receipt beside the cell, and Esc flies it up into the pill', async ({ page }) => {
  await boot(page);
  await run(page, 0);
  const receipt = page.locator('#receipt');
  await expect(receipt).toBeVisible();
  await expect(receipt.locator('.r-head .t')).toHaveText('Cell 1 · this run');
  await expect(receipt.locator('.r-vars tr')).toHaveCount(2);
  await expect(receipt.locator('.r-vars .n')).toHaveText(['prices', 'n']);
  await expect(receipt.locator('.r-vars .m')).toHaveText(['+', '+']);
  await expect(receipt.locator('.r-vars .ty').first()).toHaveText('DataFrame 250×2');
  // Focus is on ▶, not in the text: p would keep it, and the hint says so.
  await expect(receipt.locator('.r-hint')).toHaveText('type or esc ↗ · p keeps it');
  // Beside the cell, right of the column, its top on the cell's first line:
  // it never lies over the column.
  const card = await box(page, '#receipt');
  const sheet = await box(page, '#sheet');
  const editor = await boxOf(cell(page, 0).locator('.cm-editor'));
  expect(card.left).toBeGreaterThan(sheet.right);
  expect(Math.abs(card.top - editor.top)).toBeLessThan(2);
  expect(card.right).toBeLessThanOrEqual((await box(page, '#layout')).right);
  // The names wait in the card until it lands; no chip yet.
  await expect(page.locator('#session-pill .sp-names')).toHaveText('empty session');
  await expect(cell(page, 0).locator('.rchip')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(receipt).toBeHidden();
  await expect(pillNames(page)).toHaveText(['prices', 'n']);
  await expect(page.locator('#session-pill .sp-names .new')).toHaveText(['prices', 'n']);
  // The chip stays at the cell's corner, in the lane beside the column.
  const chip = cell(page, 0).locator('.rchip');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText('2');
  await expect(chip).toHaveClass(/kind-table/);
  const at = await boxOf(cell(page, 0).locator('.rchip'));
  expect(at.left).toBeGreaterThan(sheet.right);
});

test('the flight: the card shrinks into the pill and the pill\'s names update as it lands', async ({ page }) => {
  await boot(page);
  await run(page, 0);
  await expect(page.locator('#receipt')).toBeVisible();
  // Keep typing: the card flies home.
  await cell(page, 3).locator('.cm-content').click();
  await page.keyboard.type('#');
  await expect(page.locator('#receipt.flying')).toHaveCount(1);
  const mid = await page.locator('#receipt').evaluate((element) => getComputedStyle(element).transform);
  expect(mid).not.toBe('none');
  await expect(page.locator('#receipt')).toBeHidden();
  await expect(pillNames(page)).toHaveText(['prices', 'n']);
});

test('the receipt goes by itself after a while, and stays while the pointer rests on it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await boot(page);
  await run(page, 0);
  const receipt = page.locator('#receipt');
  await expect(receipt).toBeVisible();
  await receipt.hover();
  await page.clock.fastForward(8000);
  await expect(receipt).toBeVisible();
  await page.mouse.move(400, 800);
  await page.clock.fastForward(2500);
  await expect(receipt).toBeHidden();
  await expect(pillNames(page)).toHaveText(['prices', 'n']);

  await run(page, 1);
  await expect(receipt).toBeVisible();
  await page.mouse.move(400, 800);
  await page.clock.fastForward(6500);
  await expect(receipt).toBeHidden();
});

test('p keeps the receipt where it is until it is closed', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await run(page, 0);
  const receipt = page.locator('#receipt');
  await expect(receipt).toBeVisible();
  // Focus is on the run button, not in the text: p holds the card.
  await page.keyboard.press('p');
  await expect(receipt).toHaveAttribute('data-kind', 'held');
  await expect(pillNames(page)).toHaveText(['prices', 'n']);
  await page.keyboard.type('xyz');
  await expect(receipt).toBeVisible();
  await page.locator('#receipt .hb', { hasText: '✕' }).click();
  await expect(receipt).toBeHidden();
  await expect(cell(page, 0).locator('.rchip')).toBeVisible();
});

test('a run that drew shows its figure; the chip says so and reopens the receipt on hover', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await runAndFile(page, 0);
  await run(page, 1);
  const receipt = page.locator('#receipt');
  await expect(receipt.locator('.r-fig .thumb img')).toBeVisible();
  await expect(receipt.locator('.r-fig .fl')).toContainText('ax');
  await expect(receipt.locator('.r-vars .n')).toHaveText(['demand', 'elasticity', 'ax']);
  await expect(receipt.locator('.r-also')).toContainText('prices');
  await expect(receipt.locator('.r-also')).toContainText('n');
  await page.keyboard.press('Escape');
  await expect(receipt).toBeHidden();
  // The pill: in cell order, the new names blue.
  await expect(pillNames(page)).toHaveText(['prices', 'n', 'demand', 'elasticity', 'ax']);
  await expect(page.locator('#session-pill .sp-names .new')).toHaveText(['demand', 'elasticity', 'ax']);

  const chip = cell(page, 1).locator('.rchip');
  await expect(chip).toHaveClass(/kind-figure/);
  await expect(chip.locator('.pm')).toBeVisible();
  await expect(chip).toHaveText('3');
  // Hover: the receipt again, read-only, as it was.
  await chip.hover();
  await expect(receipt).toBeVisible();
  await expect(receipt).toHaveAttribute('data-kind', 'hover');
  await expect(receipt.locator('.r-head .t')).toHaveText('Cell 2 · last run');
  await expect(receipt.locator('.hb')).toHaveCount(0);
  await page.mouse.move(300, 850);
  await expect(receipt).toBeHidden();
  // A click holds it; a click elsewhere puts it away; so does Esc.
  await chip.click();
  await expect(receipt).toHaveAttribute('data-kind', 'held');
  await page.mouse.move(300, 850);
  await expect(receipt).toBeVisible();
  await page.locator('#doc').click({ position: { x: 200, y: 700 } });
  await expect(receipt).toBeHidden();
  await chip.click();
  await expect(receipt).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(receipt).toBeHidden();
});

test('an edited cell\'s chip is amber; a restart fades the chips and the pill says fresh session', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await runAndFile(page, 0);
  const chip = cell(page, 0).locator('.rchip');
  await expect(chip).toBeVisible();
  await cell(page, 0).locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' ');
  await expect(cell(page, 0).locator('.cell')).toHaveClass(/stale/);
  await expect.poll(() => chip.evaluate((element) => getComputedStyle(element).color)).toBe('rgb(201, 138, 29)');
  await page.locator('#restart').click();
  await expect(page.locator('#session-pill .sp-names')).toHaveText('fresh session');
  await expect(chip).toHaveClass(/past/);
  await expect.poll(async () => Number(await chip.evaluate((element) => getComputedStyle(element).opacity))).toBeLessThan(0.5);
  // Its cell runs again: the chip comes back.
  await runAndFile(page, 0);
  await expect(chip).not.toHaveClass(/past/);
});

test('the Session card drops from the pill and closes on a click elsewhere or Esc', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await runAndFile(page, 0);
  await runAndFile(page, 1);
  const card = page.locator('#session');
  await expect(card).toBeHidden();
  await page.locator('#session-pill').click();
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/floating/);
  await expect(page.locator('#session-pill')).toHaveClass(/open/);
  await expect(page.locator('#toggle-panel')).toHaveAttribute('aria-pressed', 'true');
  // At the room's top right, hanging from the pill.
  const at = await box(page, '#session');
  const room = await box(page, '#layout');
  expect(Math.round(room.right - at.right)).toBe(10);
  expect(Math.round(at.top - room.top)).toBe(10);
  // The last run's receipt on top, then every name with kind and cell.
  await expect(card.locator('.rv .r-head .t')).toHaveText('Last run · cell 2');
  await expect(card.locator('.s-row b')).toHaveText(['prices', 'n', 'demand', 'elasticity', 'ax']);
  await expect(card.locator('.s-row').first().locator('.cl')).toHaveText('cell 1');
  // Opening it is looking: the blue goes.
  await expect(page.locator('#session-pill .sp-names .new')).toHaveCount(0);
  await page.locator('#doc').click({ position: { x: 200, y: 700 } });
  await expect(card).toBeHidden();
  await expect(page.locator('#toggle-panel')).toHaveAttribute('aria-pressed', 'false');
  // The rail's tile opens it too, and Esc closes it.
  await page.locator('#toggle-panel').click();
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
});

test('the pin docks it beside the column, which slides left with its width unchanged, and a reload keeps it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  const before = await layout(page);
  expect(before.sheet.width).toBe(832);
  expect(Math.abs(before.sheet.left - centredLeft(before))).toBeLessThan(1);
  await page.locator('#session-pill').click();
  await page.locator('#session [data-mode="pinned"]').click();
  const card = page.locator('#session');
  await expect(card).toHaveClass(/docked/);
  await expect(page.locator('#session [data-mode="pinned"]')).toHaveAttribute('aria-checked', 'true');
  const docked = await layout(page);
  // The column slides left by only what the card lacks, its width the same.
  expect(docked.sheet.width).toBe(832);
  expect(docked.sheet.left).toBeLessThan(before.sheet.left - 50);
  // On the page beside it: past the chips' lane, 380 wide, 10 px in from
  // the room's right edge, inside the room.
  expect(docked.session.width).toBe(380);
  expect(docked.session.left).toBeGreaterThanOrEqual(docked.sheet.right + 45);
  expect(Math.round(docked.room.right - docked.session.right)).toBe(10);
  expect(await card.evaluate((element) => element.parentElement?.id)).toBe('layout');
  // A click elsewhere leaves it; so does Esc.
  await page.locator('#doc').click({ position: { x: 200, y: 700 } });
  await page.keyboard.press('Escape');
  await expect(card).toBeVisible();
  // A run never moves the column.
  await run(page, 0);
  await expect(page.locator('#session .rv .r-head .t')).toHaveText('Last run · cell 1');
  expect((await layout(page)).sheet).toEqual(docked.sheet);
  await page.reload();
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(card).toHaveClass(/docked/);
  expect((await layout(page)).sheet).toEqual(docked.sheet);
  // Unpinned, it floats again and the column goes back to the middle.
  await page.locator('#session [data-mode="peek"]').click();
  await expect(card).toHaveClass(/floating/);
  expect((await layout(page)).sheet).toEqual(before.sheet);
  await page.locator('#session .s-close').click();
  await expect(card).toBeHidden();
  await page.reload();
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(card).toBeHidden();
});

test('the slide rule: the column gives the docked card only what it lacks, narrowing to its floor, and never lies under it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // [window, the card's width, whether the column keeps 832]
  const cases: Array<[number, number | null, boolean]> = [[1470, 380, true], [1300, null, true], [1100, 320, false]];
  for (const [width, board, whole] of cases) {
    await boot(page, width, 820);
    const before = await layout(page);
    await page.locator('#toggle-panel').click();
    await page.locator('#session [data-mode="pinned"]').click();
    await expect(page.locator('#session')).toHaveClass(/docked/);
    const g = await layout(page);
    const at = `at ${width}`;
    if (board) expect(g.session.width, at).toBe(board);
    else {
      expect(g.session.width, at).toBeGreaterThan(320);
      expect(g.session.width, at).toBeLessThan(380);
    }
    // Beside the column past the chips' lane, never over it, in the room.
    expect(g.session.left, at).toBeGreaterThanOrEqual(g.sheet.right + 45);
    expect(g.session.right, at).toBeLessThanOrEqual(g.room.right - 9);
    expect(g.sideways, at).toBe(false);
    if (whole) expect(g.sheet.width, at).toBe(832);
    else {
      // Under about 1290 px the column narrows, down to 640 at the least.
      expect(g.sheet.width, at).toBeLessThan(832);
      expect(g.sheet.width, at).toBeGreaterThanOrEqual(640);
    }
    // Slid by only what the card lacks: all the way left at 1300 and 1100,
    // part of the way at 1470.
    if (width === 1470) {
      expect(g.sheet.left, at).toBeGreaterThan(g.contentLeft + 50);
      expect(g.sheet.left, at).toBeLessThan(before.sheet.left - 50);
    } else expect(Math.abs(g.sheet.left - g.contentLeft), at).toBeLessThan(1);
    await page.locator('#session [data-mode="peek"]').click();
    await page.locator('#session .s-close').click();
    expect((await layout(page)).sheet, at).toEqual(before.sheet);
  }

  // Below what the floor allows, the room scrolls sideways with the card
  // past the column's right edge, rather than the card lie over it.
  await boot(page, 1000, 760);
  await page.locator('#toggle-panel').click();
  await page.locator('#session [data-mode="pinned"]').click();
  const narrow = await layout(page);
  expect(narrow.sheet.width).toBe(640);
  expect(narrow.session.left).toBeGreaterThanOrEqual(narrow.sheet.right + 45);
  expect(narrow.sideways).toBe(true);
  await page.locator('#layout').evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  const scrolled = await layout(page);
  expect(scrolled.session.right).toBeLessThanOrEqual(scrolled.room.right - 9);
  expect(scrolled.session.left).toBeGreaterThanOrEqual(scrolled.sheet.right + 45);
});

test('the slide is animated over 0.36 s on the pin', async ({ page }) => {
  await boot(page);
  await page.locator('#toggle-panel').click();
  await page.locator('#session [data-mode="pinned"]').click();
  const sliding = await page.locator('#sheet').evaluate((element) => ({
    on: element.classList.contains('slide'),
    duration: getComputedStyle(element).transitionDuration,
    property: getComputedStyle(element).transitionProperty,
  }));
  expect(sliding.on).toBe(true);
  expect(sliding.property).toContain('margin-left');
  expect(sliding.duration).toContain('0.36s');
  await expect(page.locator('#sheet')).not.toHaveClass(/slide/);
});

test('Silent: no card and no motion; the chip and the pill update quietly', async ({ page }) => {
  await boot(page);
  await page.locator('#session-pill').click();
  await page.locator('#session [data-mode="silent"]').click();
  await page.keyboard.press('Escape');
  await run(page, 0);
  await expect(cell(page, 0).locator('.rchip')).toBeVisible();
  await expect(pillNames(page)).toHaveText(['prices', 'n']);
  await expect(page.locator('#receipt')).toBeHidden();
  await expect(page.locator('#session-pill .sp-names .land')).toHaveCount(0);
  // Remembered.
  await page.reload();
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await page.locator('#session-pill').click();
  await expect(page.locator('#session [data-mode="silent"]')).toHaveAttribute('aria-checked', 'true');
});

test('Pinned: a run\'s receipt lands in the docked card\'s top, with no card beside the cell; the chip still appears', async ({ page }) => {
  await boot(page);
  await page.locator('#toggle-panel').click();
  await page.locator('#session [data-mode="pinned"]').click();
  await run(page, 1);
  await expect(page.locator('#session .rv .r-head .t')).toHaveText('Last run · cell 2');
  await expect(page.locator('#session .rv')).toHaveClass(/landed/);
  await expect(page.locator('#receipt')).toBeHidden();
  await expect(cell(page, 1).locator('.rchip')).toBeVisible();
  await expect(pillNames(page)).toHaveText(['demand', 'elasticity', 'ax']);
});

test('Run all lays its receipts down as chips, no card, its new names blue', async ({ page }) => {
  await boot(page);
  await page.locator('#run-all').click();
  await expect(cell(page, 3).locator('.rchip')).toBeVisible();
  await expect(page.locator('#receipt')).toBeHidden();
  for (const i of [0, 1, 3]) await expect(cell(page, i).locator('.rchip')).toBeVisible();
  // Program cells only: the scratch cell did not run.
  await expect(cell(page, 2).locator('.rchip')).toHaveCount(0);
  await expect(page.locator('#session-pill .sp-names .new')).toHaveText(['prices', 'n', 'demand', 'elasticity', 'ax', 'k']);
});

test('a table pages in the Data tab, and a figure opens in the Figures tab', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await runAndFile(page, 0);
  await runAndFile(page, 1);
  await page.locator('#session-pill').click();
  await page.locator('#session .s-row', { hasText: 'prices' }).click();
  await expect(page.locator('#session [data-tab="data"]')).toHaveAttribute('aria-selected', 'true');
  const table = page.locator('#session .viewer .data-table');
  await expect(table).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(100);
  const more = page.locator('#session .viewer-foot button');
  await expect(more).toHaveText('More (100 of 250 rows)');
  await more.click();
  await expect(table.locator('tbody tr')).toHaveCount(200);
  await expect(more).toHaveText('More (200 of 250 rows)');
  await more.click();
  await expect(table.locator('tbody tr')).toHaveCount(250);
  await expect(page.locator('#session .viewer-foot')).toHaveText('250 rows');
  const requests = await page.evaluate(() => (window as Probe).__knuthTableRequests ?? []);
  expect(requests.filter((r) => r.name === 'prices').map((r) => r.offset)).toEqual([0, 100, 200]);
  // The picker holds every table; the Figures tab the figure, as an image.
  await expect(page.locator('#session [data-pane="data"] .s-pick button')).toHaveText(['prices', 'demand', 'elasticity']);
  await page.locator('#session [data-tab="figures"]').click();
  await expect(page.locator('#session [data-pane="figures"] .viewer .figure img')).toBeVisible();
  await expect(page.locator('#session [data-pane="figures"] .viewer .figure svg')).toHaveCount(0);
});

test('the receipt never lies over the column: its width follows the margin, and a margin too narrow slides the column for its stay', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1470, 1300, 1100]) {
    await boot(page, width, 760);
    const before = await layout(page);
    await run(page, 0);
    await expect(page.locator('#receipt')).toHaveClass(/show/);
    const g = await layout(page);
    const at = `at ${width}`;
    expect(g.receipt.left, at).toBeGreaterThanOrEqual(g.sheet.right);
    expect(g.receipt.right, at).toBeLessThanOrEqual(g.room.right - 7);
    expect(g.receipt.width, at).toBeGreaterThanOrEqual(160);
    expect(g.sheet.width, at).toBe(832);
    if (width === 1470) {
      // A margin of 200 and more: the card follows it, the column stays.
      expect(g.sheet.left, at).toBeCloseTo(before.sheet.left, 0);
      expect(g.receipt.width, at).toBeGreaterThanOrEqual(270);
      await expect(page.locator('#receipt'), at).not.toHaveClass(/slim/);
    } else if (width === 1300) {
      // Just under: the column slides by the difference.
      expect(g.sheet.left, at).toBeLessThanOrEqual(before.sheet.left);
      expect(g.sheet.left, at).toBeGreaterThan(before.sheet.left - 50);
      expect(g.receipt.width, at).toBeGreaterThanOrEqual(199);
    } else {
      // Well under: the column slid all the way left for the card.
      expect(Math.abs(g.sheet.left - g.contentLeft), at).toBeLessThan(1);
      await expect(page.locator('#receipt'), at).toHaveClass(/slim/);
    }
    // It flies, and the column comes back.
    await page.keyboard.press('Escape');
    await expect(page.locator('#receipt')).toBeHidden();
    expect((await layout(page)).sheet, at).toEqual(before.sheet);
  }
  // A chip's card stands past its chip, and slides the column too.
  const chip = cell(page, 0).locator('.rchip');
  await chip.click();
  await expect(page.locator('#receipt')).toHaveAttribute('data-kind', 'held');
  const held = await layout(page);
  expect(held.receipt.left).toBeGreaterThanOrEqual(held.sheet.right);
  await page.keyboard.press('Escape');
});

test('a slim card shows a short value in place of its kind, which stays in the tooltip', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, 1100, 760);
  await run(page, 0);
  const receipt = page.locator('#receipt');
  await expect(receipt).toHaveClass(/slim/);
  const n = receipt.locator('tr', { hasText: 'n' }).last();
  await expect(n.locator('.pv')).toBeVisible();
  await expect(n.locator('.pv')).toHaveText('1200');
  await expect(n.locator('.ty')).toBeHidden();
  await expect(n).toHaveAttribute('title', 'n: int');
  // A table keeps its kind.
  const prices = receipt.locator('tr', { hasText: 'prices' });
  await expect(prices.locator('.ty')).toBeVisible();
  await expect(prices.locator('.pv')).toBeHidden();
  // The hint on one line, whole.
  const hint = await receipt.locator('.r-hint').evaluate((element) => ({
    lines: Math.round((element.clientHeight - parseFloat(getComputedStyle(element).paddingTop) - parseFloat(getComputedStyle(element).paddingBottom)) / parseFloat(getComputedStyle(element).lineHeight)),
    whole: element.scrollWidth <= element.clientWidth + 1,
  }));
  expect(hint).toEqual({ lines: 1, whole: true });
  // A chip under the lane tucks inside the cell's corner.
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 900, height: 760 });
  const sheet = await box(page, '#sheet');
  const tight = await boxOf(cell(page, 0).locator('.rchip'));
  expect(tight.right).toBeLessThanOrEqual(sheet.right);
  expect(await page.locator('#layout').evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
});

test('a click anywhere on a fresh receipt keeps it, and the hint says click while the text has the focus', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await cell(page, 3).locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Enter');
  const receipt = page.locator('#receipt');
  await expect(receipt).toBeVisible();
  await expect(receipt.locator('.r-hint')).toHaveText('type or esc ↗ · click to keep');
  await receipt.locator('.r-head .t').click();
  await expect(receipt).toHaveAttribute('data-kind', 'held');
  await expect(receipt.locator('.r-hint')).toHaveCount(0);
  // The cursor stayed in the cell: typing goes there, and the card stays.
  await page.keyboard.press('End');
  await page.keyboard.type('4');
  await expect(cell(page, 3).locator('.cm-content')).toHaveText('k = 34');
  await expect(receipt).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(receipt).toBeHidden();
});

test('the pill hides the least recently bound names, never those a receipt brings home', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, 760, 700);
  await page.locator('#run-all').click();
  await expect(cell(page, 3).locator('.rchip')).toBeVisible();
  // Cell 1 again (prices and n, rebound): its names come home.
  await runAndFile(page, 0);
  const more = page.locator('#session-pill .sp-more');
  await expect(more).toBeVisible();
  const visible = await pillNames(page).allTextContents();
  expect(visible).toEqual(expect.arrayContaining(['prices', 'n']));
  // What gave way is the oldest of the rest, in the order they were bound.
  const order = ['demand', 'elasticity', 'ax', 'k'];
  const hidden = order.filter((name) => !visible.includes(name));
  expect(hidden.length).toBeGreaterThan(0);
  expect(hidden).toEqual(order.slice(0, hidden.length));
  await expect(more).toHaveText(`+${hidden.length}`);
});

test('Pinned: a chip\'s hover shows its receipt in the docked card\'s band, and a click keeps it there', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await page.locator('#toggle-panel').click();
  await page.locator('#session [data-mode="pinned"]').click();
  await run(page, 0);
  await expect(cell(page, 0).locator('.rchip')).toBeVisible();
  await run(page, 1);
  const band = page.locator('#session .rv.band');
  await expect(band.locator('.r-head .t')).toHaveText('Last run · cell 2');
  const chip = cell(page, 0).locator('.rchip');
  await chip.hover();
  await expect(band.locator('.r-head .t')).toHaveText('Earlier run · cell 1');
  await expect(band).toHaveClass(/earlier/);
  await expect(band.locator('.b-row b')).toHaveText(['prices', 'n']);
  await expect(chip).toHaveClass(/\bon\b/);
  // No card over the docked one.
  await expect(page.locator('#receipt')).toBeHidden();
  await page.mouse.move(300, 850);
  await expect(band.locator('.r-head .t')).toHaveText('Last run · cell 2');
  // A click keeps it there; Esc goes back to the last run.
  await chip.click();
  await page.mouse.move(300, 850);
  await page.waitForTimeout(300);
  await expect(band.locator('.r-head .t')).toHaveText('Earlier run · cell 1');
  await page.keyboard.press('Escape');
  await expect(band.locator('.r-head .t')).toHaveText('Last run · cell 2');
  // A hover from the Data tab shows the band and goes back when it ends.
  await page.locator('#session [data-tab="data"]').click();
  await chip.hover();
  await expect(page.locator('#session [data-tab="session"]')).toHaveAttribute('aria-selected', 'true');
  await expect(band.locator('.r-head .t')).toHaveText('Earlier run · cell 1');
  await page.mouse.move(300, 850);
  await expect(page.locator('#session [data-tab="data"]')).toHaveAttribute('aria-selected', 'true');
});

test('the docked band keeps the values: a short table whole, the figure at its width', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await page.locator('#toggle-panel').click();
  await page.locator('#session [data-mode="pinned"]').click();
  await run(page, 0);
  const band = page.locator('#session .rv.band');
  await expect(band.locator('.b-val.pv')).toHaveText([/price/, '1200']);
  await run(page, 1);
  // demand and elasticity are three-row Series: whole, as mini tables.
  await expect(band.locator('.b-val .mt')).toHaveCount(2);
  await expect(band.locator('.r-fig.wide .thumb img')).toBeVisible();
  const fig = await boxOf(band.locator('.r-fig.wide .thumb'));
  expect(fig.width).toBeGreaterThan(300);
});

test('in source view the pill rests, and its title says why', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await runAndFile(page, 0);
  const pill = page.locator('#session-pill');
  await page.locator('#view-toggle').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'source');
  await expect(pill).toHaveAttribute('aria-disabled', 'true');
  await expect(pill).toHaveAttribute('title', /switch to cell view/);
  await pill.click({ force: true });
  await expect(page.locator('#session')).toBeHidden();
  await expect(pill).not.toHaveClass(/open/);
  // The status still reads, and the names are there.
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await page.locator('#view-toggle').click();
  await expect(pill).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#session')).toBeHidden();
  await pill.click();
  await expect(page.locator('#session')).toBeVisible();
});

test('a change in place, which the run\'s report cannot see, gets its receipt once the snapshot does', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await runAndFile(page, 0);
  // A new last cell that only changes prices in place.
  await cell(page, 3).locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('prices["log_q"] = 1');
  await run(page, 3);
  const receipt = page.locator('#receipt');
  await expect(receipt).toBeVisible();
  await expect(receipt.locator('.r-vars .n')).toHaveText(['prices']);
  await expect(receipt.locator('.r-vars .m')).toHaveText(['~']);
  await expect(receipt.locator('.r-vars .m')).toHaveAttribute('title', /in place/);
  await expect(receipt.locator('.r-vars .ty')).toHaveText(['DataFrame 250×3']);
});

test('Esc in a cell puts the receipt away and still arms the cell\'s kind chord', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await cell(page, 3).locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('#receipt')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#receipt')).toBeHidden();
  await page.keyboard.press('s');
  await expect(cell(page, 3).locator('.cell')).toHaveClass(/kind-scratch/);
  await expect(pillNames(page)).toHaveText(['k']);
});

test('p while typing in a cell types a p and puts the receipt away', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await cell(page, 3).locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('#receipt')).toBeVisible();
  await expect(page.locator('#receipt .r-hint')).toHaveText('type or esc ↗ · click to keep');
  await page.keyboard.press('End');
  await page.keyboard.type('p');
  await expect(page.locator('#receipt')).toBeHidden();
  await expect(cell(page, 3).locator('.cm-content')).toHaveText('k = 3p');
});
