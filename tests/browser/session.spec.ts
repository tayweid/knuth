// The session (src/session.ts, docs/SESSION.md): a run's receipt beside the
// cell that flies up into the pill, the chip it leaves at the cell's corner,
// and the Session card from the pill — floating, docked beside the column
// (which slides left for it), its three modes and its Data and Figures
// tabs. The mock engine answers a run the way the real
// one does: a done event whose `bound` lists what the cell assigned, a
// figures event for a cell that plots, and a namespace that keeps them —
// one request at a time, in order, as the engine takes them (a cell with
// `sleep(s)` in it takes s seconds).
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
      // A numpy scalar, as the engine previews it: by its value.
      est: { type: 'float64', shape: [], preview: '-0.4088817904210866', saved: true },
    };
    class MockWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.CONNECTING;
      private ns = new Map<string, Record<string, unknown>>();
      private queue: Promise<void> = Promise.resolve();

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
        if (msg.type === 'run') probe.__knuthRuns = (probe.__knuthRuns ?? 0) + 1;
        // One at a time, in order: a namespace asked for while runs are
        // queued is answered once they have run.
        this.queue = this.queue.then(() => this.handle(msg));
      }

      private async handle(msg: Record<string, unknown>) {
        const probe = window as Probe;
        if (msg.type === 'attach') {
          this.reply({ type: 'attached', protocol: msg.protocol, session: msg.session, resumed: false });
          this.reply({ type: 'ready' });
        } else if (msg.type === 'restart') {
          this.ns.clear();
          this.reply({ type: 'ready', id: msg.id });
        } else if (msg.type === 'run') {
          const sleep = /sleep\(([\d.]+)\)/.exec(String(msg.code));
          await new Promise((done) => window.setTimeout(done, sleep ? Number(sleep[1]) * 1000 : 30));
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
          this.reply({ type: 'done', id: msg.id, result: null, bound });
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

/** Float: a run's receipt kept beside the cell, the column making room
 *  (Peek, the default, sends it straight up into the pill). */
async function float(page: Page) {
  await page.addInitScript(() => localStorage.setItem('knuth-receipts', 'float'));
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

test('Peek: a run\'s receipt shows beside the cell and goes straight up into the pill, the column never moving', async ({ page }) => {
  await boot(page, 1100, 760);
  const before = await layout(page);
  const stop = await traceFrom(page, 'never-fired');
  await run(page, 0);
  const receipt = page.locator('#receipt');
  await expect(receipt).toHaveAttribute('data-cell', /c\d+/);
  await expect(receipt).toBeHidden();
  await expect(pillNames(page)).toHaveText(['prices', 'n']);
  await expect(page.locator('#session-pill .sp-names .new')).toHaveText(['prices', 'n']);
  const { samples, flying, hidden } = await stop();
  // Seen beside the cell, then flying as soon as it has eased in: no pause.
  expect(flying).not.toBeNull();
  expect(hidden! - flying!).toBeLessThan(700);
  expect(new Set(samples.map((s) => s.left))).toEqual(new Set([Math.round(before.sheet.left)]));
  // The chip stays at the cell's corner.
  const chip = cell(page, 0).locator('.rchip');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText('2');
  await expect(chip).toHaveClass(/kind-table/);
});

test('Peek: the pointer resting on the receipt does not keep it', async ({ page }) => {
  await boot(page);
  await run(page, 0);
  const receipt = page.locator('#receipt');
  await expect(receipt).toHaveClass(/show/);
  // Onto it while it shows (Playwright's hover would wait for it to stand
  // still, which it never does).
  const at = await box(page, '#receipt');
  await page.mouse.move(at.left + 20, at.top + 20);
  await expect(receipt).toHaveClass(/flying/, { timeout: 1500 });
  await expect(pillNames(page)).toHaveText(['prices', 'n']);
  // Landed, its chip comes up under the pointer, whose hover is the chip's.
  await expect(receipt).not.toHaveAttribute('data-kind', 'fresh');
});

test('Float: a run\'s receipt stays beside the cell, kept, until Esc flies it up into the pill', async ({ page }) => {
  await float(page);
  await boot(page);
  await run(page, 0);
  const receipt = page.locator('#receipt');
  await expect(receipt).toBeVisible();
  await expect(receipt).toHaveAttribute('data-kind', 'held');
  await expect(receipt.locator('.r-head .t')).toHaveText('Cell 1 · this run');
  await expect(receipt.locator('.r-vars tr')).toHaveCount(2);
  await expect(receipt.locator('.r-vars .n')).toHaveText(['prices', 'n']);
  await expect(receipt.locator('.r-vars .m')).toHaveText(['+', '+']);
  await expect(receipt.locator('.r-vars .ty').first()).toHaveText('DataFrame 250×2');
  // Measured once it has eased in.
  await receipt.evaluate((element) => Promise.all(element.getAnimations().map((a) => a.finished)));
  // Beside the cell, right of the column, its top on the cell's first line:
  // it never lies over the column.
  const card = await box(page, '#receipt');
  const sheet = await box(page, '#sheet');
  const editor = await boxOf(cell(page, 0).locator('.cm-editor'));
  expect(card.left).toBeGreaterThan(sheet.right);
  expect(Math.abs(card.top - editor.top)).toBeLessThan(2);
  expect(card.right).toBeLessThanOrEqual((await box(page, '#layout')).right);
  await expect(cell(page, 0).locator('.rchip')).toHaveCount(0);
  // Typing and a click back into the text leave it where it is.
  await cell(page, 3).locator('.cm-content').click();
  await page.keyboard.type('# x');
  await page.waitForTimeout(400);
  await expect(receipt).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(receipt).toBeHidden();
  await expect(pillNames(page)).toHaveText(['prices', 'n']);
  const chip = cell(page, 0).locator('.rchip');
  await expect(chip).toBeVisible();
  const at = await boxOf(chip);
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
      // Under about 1275 px the column narrows, down to 640 at the least.
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
  // past the column's right edge, rather than the card lie over it; the
  // pin scrolls it there, the card's controls in view.
  await boot(page, 1000, 760);
  await page.locator('#toggle-panel').click();
  await page.locator('#session [data-mode="pinned"]').click();
  const narrow = await layout(page);
  expect(narrow.sheet.width).toBe(640);
  expect(narrow.session.left).toBeGreaterThanOrEqual(narrow.sheet.right + 45);
  expect(narrow.sideways).toBe(true);
  expect(narrow.session.right).toBeLessThanOrEqual(narrow.room.right - 9);
  const close = await box(page, '#session .s-close');
  expect(close.right).toBeLessThanOrEqual(narrow.room.right);
});

test('the slide is animated over 0.36 s on the pin, the card fading in once the column has cleared its place', async ({ page }) => {
  for (const width of [1500, 1100]) {
    await boot(page, width, 760);
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
    // The card's fade waits for the column's right edge to pass its left.
    const delay = await page.locator('#session').evaluate((element) =>
      Number(element.getAnimations().at(-1)?.effect?.getTiming().delay ?? -1));
    expect(delay, `at ${width}`).toBeGreaterThan(40);
    expect(delay, `at ${width}`).toBeLessThan(360);
    await expect(page.locator('#sheet')).not.toHaveClass(/slide/);
    await page.locator('#session [data-mode="peek"]').click();
    await page.locator('#session .s-close').click();
  }
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

test('Float: the receipt never lies over the column: its width follows the margin, and a margin too narrow slides the column for its stay', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await float(page);
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
      // A few px short of 200: the card takes the margin as it is, and the
      // column does not twitch for it.
      expect(g.sheet.left, at).toBeCloseTo(before.sheet.left, 0);
      expect(g.receipt.width, at).toBeGreaterThanOrEqual(192);
      expect(g.receipt.width, at).toBeLessThan(200);
    } else {
      // Well under: the column slid all the way left for the card.
      expect(Math.abs(g.sheet.left - g.contentLeft), at).toBeLessThan(1);
      await expect(page.locator('#receipt'), at).toHaveClass(/slim/);
    }
    // It flies, and the column comes back once no other card follows.
    await page.keyboard.press('Escape');
    await expect(page.locator('#receipt')).toBeHidden();
    await expect.poll(async () => (await layout(page)).sheet, { message: at }).toEqual(before.sheet);
  }
  // A chip's click where the margin past the chip is short: the card
  // stands as a run's does, over the lane, and the column slides for it.
  const chip = cell(page, 0).locator('.rchip');
  await chip.click();
  await expect(page.locator('#receipt')).toHaveAttribute('data-kind', 'held');
  const held = await layout(page);
  expect(held.receipt.left).toBeGreaterThanOrEqual(held.sheet.right);
  await page.keyboard.press('Escape');
});

/** Every left edge #sheet takes, frame by frame, from now until `stop`. */
async function traceColumn(page: Page) {
  await page.evaluate(() => {
    const probe = window as typeof window & { __lefts?: number[]; __tracing?: boolean };
    probe.__lefts = [];
    probe.__tracing = true;
    const sheet = document.getElementById('sheet')!;
    const tick = () => {
      if (!probe.__tracing) return;
      probe.__lefts!.push(Math.round(sheet.getBoundingClientRect().left));
      requestAnimationFrame(tick);
    };
    tick();
  });
  return async () => page.evaluate(() => {
    const probe = window as typeof window & { __lefts?: number[]; __tracing?: boolean };
    probe.__tracing = false;
    return [...new Set(probe.__lefts)];
  });
}

test('Float: stepping through cells at 1100 slides the column once, not per run, and it comes home when the cards stop', async ({ page }) => {
  await float(page);
  await boot(page, 1100, 760);
  const before = await layout(page);
  await run(page, 0);
  await expect(page.locator('#receipt')).toHaveClass(/show/);
  await expect(page.locator('#sheet')).not.toHaveClass(/slide/);
  const slid = (await layout(page)).sheet.left;
  expect(Math.abs(slid - before.contentLeft)).toBeLessThan(1);
  // Two more runs, each putting the last card away (the click on ▶) and
  // bringing its own: the column never moves.
  const stop = await traceColumn(page);
  for (const i of [1, 3]) {
    await run(page, i);
    const id = await cell(page, i).getAttribute('data-cell');
    await expect(page.locator('#receipt')).toHaveAttribute('data-cell', id!);
    await expect(page.locator('#receipt')).toHaveClass(/show/);
    await page.waitForTimeout(300);
  }
  expect(await stop()).toEqual([Math.round(slid)]);
  // Esc puts the last one away on purpose: the column comes home with it,
  // not RETURN_MS later (the traces below time it frame by frame).
  const stopped = Date.now();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await layout(page)).sheet.left, { intervals: [50] }).toBeCloseTo(before.sheet.left, 0);
  expect(Date.now() - stopped).toBeLessThan(900);
});

type Sample = { t: number; left: number };
/** #sheet's left edge every frame, with when the first `event` on
 *  `selector` (window for keys) came — the dismissal — and when the
 *  receipt began its flight home and went hidden, if it did. */
async function traceFrom(page: Page, event: string, selector?: string) {
  await page.evaluate(({ event, selector }) => {
    const probe = window as typeof window & { __samples?: Array<{ t: number; left: number }>; __tracing?: boolean; __at?: number; __hidden?: number; __flying?: number };
    probe.__samples = [];
    probe.__tracing = true;
    delete probe.__at;
    delete probe.__hidden;
    delete probe.__flying;
    const sheet = document.getElementById('sheet')!;
    const receipt = document.getElementById('receipt')!;
    const target: EventTarget = selector ? document.querySelector(selector)! : window;
    target.addEventListener(event, () => (probe.__at ??= performance.now()), { capture: true, once: true });
    new MutationObserver(() => {
      if (receipt.classList.contains('flying')) probe.__flying ??= performance.now();
      if (receipt.hidden) probe.__hidden ??= performance.now();
    }).observe(receipt, { attributes: true, attributeFilter: ['hidden', 'class'] });
    const tick = (t: number) => {
      if (!probe.__tracing) return;
      probe.__samples!.push({ t, left: Math.round(sheet.getBoundingClientRect().left) });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { event, selector });
  return async () => page.evaluate(() => {
    const probe = window as typeof window & { __samples?: Array<{ t: number; left: number }>; __tracing?: boolean; __at?: number; __hidden?: number; __flying?: number };
    probe.__tracing = false;
    return { samples: probe.__samples!, at: probe.__at ?? null, hidden: probe.__hidden ?? null, flying: probe.__flying ?? null };
  });
}

/** The trace relative to `zero`: [ms, left] wherever the left changes. */
const changes = (samples: Sample[], zero: number) =>
  samples.filter((s, i) => i === 0 || s.left !== samples[i - 1].left).map((s) => [Math.round(s.t - zero), s.left]);

/** Ms from `zero` to the first frame off `from`, and to the first at `to`. */
function timing(samples: Sample[], zero: number, from: number, to: number) {
  const after = samples.filter((s) => s.t >= zero);
  const moved = after.find((s) => s.left !== from);
  const home = after.find((s) => s.left === to);
  return { moved: moved ? moved.t - zero : Infinity, home: home ? home.t - zero : Infinity };
}

/** A run's card at 1100, and the column slid all the way left for it. */
async function slidForCard(page: Page) {
  await float(page);
  await boot(page, 1100, 760);
  const before = await layout(page);
  await run(page, 0);
  const receipt = page.locator('#receipt');
  await expect(receipt).toHaveClass(/show/);
  await expect(page.locator('#sheet')).not.toHaveClass(/slide/);
  const slid = Math.round((await layout(page)).sheet.left);
  expect(Math.abs(slid - before.contentLeft)).toBeLessThan(1);
  const home = Math.round(before.sheet.left);
  expect(home).toBe(148);
  return { slid, home };
}

test('Float: Esc on a receipt at 1100 brings the column home at once: the slide starts with the dismissal', async ({ page }) => {
  const { slid, home } = await slidForCard(page);
  const stop = await traceFrom(page, 'keydown');
  await page.keyboard.press('Escape');
  await expect(page.locator('#receipt')).toBeHidden();
  await expect.poll(async () => (await layout(page)).sheet.left, { intervals: [50] }).toBeCloseTo(home, 0);
  await page.waitForTimeout(100);
  const { samples, at } = await stop();
  const { moved, home: landed } = timing(samples, at!, slid, home);
  console.log('Esc at 1100:', JSON.stringify(changes(samples, at!)));
  // Moving by the frame after the key (a frame is ~17 ms; the first frame
  // after it starts the transition), home with the 0.36 s slide.
  expect(moved).toBeLessThan(50);
  expect(landed).toBeLessThan(450);
  // One way only: out → home, never back.
  expect(samples.filter((s) => s.t > at! + landed).every((s) => s.left === home)).toBe(true);
});

test('Float: the receipt\'s ✕ at 1100 brings the column home at once', async ({ page }) => {
  {
    const { slid, home } = await slidForCard(page);
    const label = 'kept';
    const stop = await traceFrom(page, 'click', '#receipt');
    await page.locator('#receipt .hb', { hasText: '✕' }).click();
    await expect(page.locator('#receipt')).toBeHidden();
    await expect.poll(async () => (await layout(page)).sheet.left, { intervals: [50] }).toBeCloseTo(home, 0);
    await page.waitForTimeout(100);
    const { samples, at } = await stop();
    const { moved, home: landed } = timing(samples, at!, slid, home);
    console.log(`✕ (${label}) at 1100:`, JSON.stringify(changes(samples, at!)));
    expect(moved, label).toBeLessThan(50);
    expect(landed, label).toBeLessThan(450);
  }
});

test('Float: a click back into the text leaves the card and the column; a click outside both brings the column home at once', async ({ page }) => {
  const { slid, home } = await slidForCard(page);
  const stop = await traceColumn(page);
  await cell(page, 1).locator('.cm-content').click();
  await page.keyboard.type('# x');
  await page.waitForTimeout(1500);
  await expect(page.locator('#receipt')).toBeVisible();
  expect(await stop()).toEqual([slid]);
  // The receipt still up: Esc, so the next run's card brings it back out.
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await layout(page)).sheet.left, { intervals: [50] }).toBeCloseTo(home, 0);

  // On the room's margin, past the column: putting it away.
  await run(page, 0);
  await expect(page.locator('#receipt')).toHaveClass(/show/);
  await expect(page.locator('#sheet')).not.toHaveClass(/slide/);
  const away = await traceFrom(page, 'mousedown', '#layout');
  const room = await box(page, '#layout');
  const spot = { x: room.right - 30, y: room.bottom - 30 };
  expect(await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit?.closest('#layout') && !hit.closest('#sheet') && !hit.closest('#receipt');
  }, spot)).toBe(true);
  await page.mouse.click(spot.x, spot.y);
  await expect(page.locator('#receipt')).toBeHidden();
  await expect.poll(async () => (await layout(page)).sheet.left, { intervals: [50] }).toBeCloseTo(home, 0);
  await page.waitForTimeout(100);
  const out = await away();
  const t = timing(out.samples, out.at!, slid, home);
  console.log('a click on the room at 1100:', JSON.stringify(changes(out.samples, out.at!)));
  expect(t.moved).toBeLessThan(50);
  expect(t.home).toBeLessThan(450);
});

test('Esc on a kept receipt while a run is going keeps the column out for that run\'s card', async ({ page }) => {
  await float(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, 1100, 760);
  await cell(page, 3).locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('k = 3  # time.sleep(1.5)');
  await run(page, 0);
  await expect(page.locator('#receipt')).toHaveClass(/show/);
  const slid = Math.round((await layout(page)).sheet.left);
  // Kept (Float), then the slow cell run by keyboard, the kept card still
  // up; Esc puts it away while that run is going.
  await expect(page.locator('#receipt')).toHaveAttribute('data-kind', 'held');
  await cell(page, 3).locator('.cm-content').evaluate((element) => (element as HTMLElement).focus());
  const stop = await traceColumn(page);
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator('#receipt')).toBeHidden();
  const receipt = page.locator('#receipt');
  await expect(receipt).toHaveAttribute('data-cell', (await cell(page, 3).getAttribute('data-cell'))!, { timeout: 5_000 });
  await expect(receipt).toHaveClass(/show/);
  expect(await stop()).toEqual([slid]);
});

test('stepping with Shift-Enter at 1100 slides the column once out and once home', async ({ page }) => {
  await float(page);
  await boot(page, 1100, 760);
  const home = Math.round((await layout(page)).sheet.left);
  const stop = await traceFrom(page, 'never-fired');
  await cell(page, 0).locator('.cm-content').click();
  for (const i of [0, 1, 2]) {
    await page.keyboard.press('Shift+Enter');
    const id = await cell(page, i).getAttribute('data-cell');
    await expect(page.locator('#receipt')).toHaveAttribute('data-cell', id!);
    await expect(page.locator('#receipt')).toHaveClass(/show/);
    await page.waitForTimeout(400);
  }
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await layout(page)).sheet.left, { intervals: [50] }).toBeCloseTo(home, 0);
  await page.waitForTimeout(100);
  const { samples } = await stop();
  const lefts = samples.map((s) => s.left).filter((left, i, all) => i === 0 || left !== all[i - 1]);
  console.log('Shift-Enter ×3 at 1100:', JSON.stringify(changes(samples, samples[0].t)));
  // Down to its slid edge once, then up to home once: no turn but one.
  const turn = lefts.indexOf(Math.min(...lefts));
  expect(lefts[0]).toBe(home);
  expect(lefts.at(-1)).toBe(home);
  for (let i = 1; i <= turn; i++) expect(lefts[i]).toBeLessThan(lefts[i - 1]);
  for (let i = turn + 1; i < lefts.length; i++) expect(lefts[i]).toBeGreaterThan(lefts[i - 1]);
});

test('a chip\'s hover never moves the column, nor in Peek its click, which opens the receipt over the page', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, 1100, 760);
  const before = await layout(page);
  await runAndFile(page, 0);
  await expect.poll(async () => (await layout(page)).sheet.left).toBeCloseTo(before.sheet.left, 0);
  const chip = cell(page, 0).locator('.rchip');
  const stop = await traceColumn(page);
  await chip.hover();
  await page.waitForTimeout(500);
  await expect(page.locator('#receipt')).toBeHidden();
  expect(await stop()).toEqual([Math.round(before.sheet.left)]);
  await expect(chip).toHaveAttribute('title', /^prices, n — click for the receipt$/);
  // Its accessible name never offers hover, which a keyboard never makes.
  await expect(chip).toHaveAttribute('aria-label', 'Receipt of cell 1\'s last run: prices, n — click for the receipt');
  // The click: held, over the page as it stands — the column never moves
  // for it in Peek (Float slides it, as for a run's card).
  const clicked = await traceColumn(page);
  await chip.click();
  await expect(page.locator('#receipt')).toHaveAttribute('data-kind', 'held');
  await page.waitForTimeout(400);
  expect(await clicked()).toEqual([Math.round(before.sheet.left)]);
  const held = await layout(page);
  expect(held.receipt.right).toBeLessThanOrEqual(held.room.right - 7);
  await page.keyboard.press('Escape');
  await expect(page.locator('#receipt')).toBeHidden();

  // At 1470 the margin past the chip holds a card: hover opens it there,
  // and the column stays.
  await boot(page, 1470, 820);
  const wide = await layout(page);
  await runAndFile(page, 0);
  await chip.hover();
  await expect(page.locator('#receipt')).toHaveAttribute('data-kind', 'hover');
  const g = await layout(page);
  expect(g.sheet).toEqual(wide.sheet);
  expect(g.receipt.left).toBeGreaterThanOrEqual((await boxOf(chip)).right);
  await expect(chip).toHaveAttribute('aria-label', 'Receipt of cell 1\'s last run: prices, n — click for the receipt');
});

test('a numpy scalar shows its value on a slim card, to six digits, whole in the tooltip', async ({ page }) => {
  await float(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, 1100, 760);
  await cell(page, 3).locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('est = 0');
  await page.keyboard.press('ControlOrMeta+Enter');
  const receipt = page.locator('#receipt');
  await expect(receipt).toHaveClass(/slim/);
  const row = receipt.locator('tr', { hasText: 'est' });
  await expect(row.locator('.pv')).toHaveText('-0.408882', { useInnerText: true });
  await expect(row.locator('.ty')).toBeHidden();
  await expect(row).toHaveAttribute('title', 'est: float64 · -0.4088817904210866');
  // A wide card shows it whole.
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1500, height: 760 });
  await cell(page, 3).locator('.run').click();
  await expect(receipt).not.toHaveClass(/slim/);
  await expect(receipt.locator('tr', { hasText: 'est' }).locator('.pv')).toHaveText('-0.4088817904210866', { useInnerText: true });
});

test('a run that binds hundreds of names lists eight, says how many more, and the Session card has them; its chip reads 99+', async ({ page }) => {
  await float(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const lines = Array.from({ length: 120 }, (_, i) => `v${String(i).padStart(3, '0')} = ${i}`);
    sessionStorage.setItem('knuth-doc', JSON.stringify({
      name: 'many.py',
      dirty: false,
      text: ['# %%', 'prices = read_csv("prices.csv")', '', '# %%', ...lines, ''].join('\n'),
    }));
  });
  await boot(page, 1470, 820);
  await cell(page, 1).locator('.cm-line').first().click();
  await page.keyboard.press('ControlOrMeta+Enter');
  const receipt = page.locator('#receipt');
  await expect(receipt).toHaveClass(/show/);
  await expect(receipt.locator('.r-vars tr')).toHaveCount(8);
  await expect(receipt.locator('.r-more')).toHaveText('+112 more · in the Session card');
  // The whole card in the room.
  const card = await box(page, '#receipt');
  expect(card.bottom).toBeLessThanOrEqual((await box(page, '#layout')).bottom);
  await receipt.locator('.r-more').click();
  await expect(receipt).toBeHidden();
  await expect(page.locator('#session')).toHaveClass(/floating/);
  // The caret never left the cell, as with the pill.
  expect(await page.evaluate(() => document.activeElement?.classList.contains('cm-content'))).toBe(true);
  await expect(page.locator('#session [data-tab="session"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#session .s-list .s-row')).toHaveCount(120);
  await page.keyboard.press('Escape');
  // The chip: 99 and a raised +, as narrow as two digits, so the docked
  // card past the lane never covers it.
  const chip = cell(page, 1).locator('.rchip');
  await expect(chip).toHaveText('99');
  await expect(chip.locator('.n')).toHaveClass(/over/);
  await page.locator('#session-pill').click();
  await page.locator('#session [data-mode="pinned"]').click();
  await expect(page.locator('#session')).toHaveClass(/docked/);
  const at = await boxOf(chip);
  const board = await box(page, '#session');
  expect(at.right).toBeLessThanOrEqual(board.left - 1);
  expect(at.width).toBeLessThanOrEqual(38.5);
  // The docked band lists the first eight too; the rest are the list below.
  await expect(page.locator('#session .rv.band .b-row')).toHaveCount(8);
  await expect(page.locator('#session .rv.band .r-more')).toHaveText('+112 more · in the session, below');
});

test('a slim card shows a short value in place of its kind, which stays in the tooltip', async ({ page }) => {
  await float(page);
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
  // A chip under the lane tucks inside the cell's corner.
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 900, height: 760 });
  const sheet = await box(page, '#sheet');
  const tight = await boxOf(cell(page, 0).locator('.rchip'));
  expect(tight.right).toBeLessThanOrEqual(sheet.right);
  expect(await page.locator('#layout').evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
});

test('the pill hides the least recently bound names, never those a receipt brings home', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, 680, 700);
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
  await float(page);
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
  await float(page);
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

/** "31 ms", "0.80 s": a receipt's time, in ms. */
const msOf = (text: string) => (text.endsWith(' ms') ? parseFloat(text) : parseFloat(text) * 1000);

test('runs queued behind a busy kernel credit each cell with its own names, and time each run alone', async ({ page }) => {
  await float(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    sessionStorage.setItem('knuth-doc', JSON.stringify({
      name: 'queued.py',
      dirty: false,
      text: ['# %%', 'time.sleep(0.8)', 'a = 1', '', '# %%', 'b = 2', 'c = 3', '', '# %%', 'd = 4', ''].join('\n'),
    }));
  });
  await boot(page);
  // Three runs asked for while the first is still going: the engine takes
  // them in order, and the snapshot the first run's receipt asks for comes
  // after the other two have run.
  for (const i of [0, 1, 2]) await run(page, i);
  const receipt = page.locator('#receipt');
  await expect(receipt).toHaveAttribute('data-cell', (await cell(page, 2).getAttribute('data-cell'))!);
  await expect(receipt.locator('.r-vars .n')).toHaveText(['d']);
  // Its own time, not the wait behind the slow cell.
  expect(msOf((await receipt.locator('.r-head .took').textContent())!)).toBeLessThan(500);
  await page.keyboard.press('Escape');
  await expect(receipt).toBeHidden();
  // Each chip names its own cell's names, once every snapshot is in.
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __knuthRuns?: number }).__knuthRuns)).toBe(3);
  await page.waitForTimeout(200);
  const chips = [0, 1, 2].map((i) => cell(page, i).locator('.rchip'));
  await expect(chips[0]).toHaveText('1');
  await expect(chips[0]).toHaveAttribute('title', /^a — /);
  await expect(chips[1]).toHaveText('2');
  await expect(chips[1]).toHaveAttribute('title', /^b, c — /);
  await expect(chips[2]).toHaveText('1');
  await expect(chips[2]).toHaveAttribute('title', /^d — /);
  // The second run's receipt: its names, its own time.
  await chips[1].hover();
  await expect(receipt).toHaveAttribute('data-kind', 'hover');
  await expect(receipt.locator('.r-vars .n')).toHaveText(['b', 'c']);
  expect(msOf((await receipt.locator('.r-head .took').textContent())!)).toBeLessThan(500);
  await page.mouse.move(300, 850);
  await expect(receipt).toBeHidden();
  // The Session tab says which cell bound each, so "go there" goes there.
  await page.locator('#session-pill').click();
  const where = (name: string) => page.locator('#session .s-row', { has: page.locator('b', { hasText: new RegExp(`^${name}$`) }) }).locator('.cl');
  await expect(where('a')).toHaveText('cell 1');
  await expect(where('b')).toHaveText('cell 2');
  await expect(where('c')).toHaveText('cell 2');
  await expect(where('d')).toHaveText('cell 3');
});

test('a run still going keeps the column where the last card left it, and its card stands there', async ({ page }) => {
  await float(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, 1100, 760);
  const before = await layout(page);
  await cell(page, 3).locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('k = 3  # time.sleep(2.4)');
  await run(page, 0);
  await expect(page.locator('#receipt')).toHaveClass(/show/);
  const slid = (await layout(page)).sheet.left;
  expect(Math.abs(slid - before.contentLeft)).toBeLessThan(1);
  // The slow cell, then a few keys in it: the return falls due well before
  // the run ends, and waits for it. The cursor goes to it without a click,
  // which would send the column home before the run begins.
  const stop = await traceColumn(page);
  await cell(page, 3).locator('.cm-content').focus();
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.keyboard.press('End');
  await page.keyboard.type('!', { delay: 100 });
  const receipt = page.locator('#receipt');
  await expect(receipt).toHaveAttribute('data-cell', (await cell(page, 3).getAttribute('data-cell'))!, { timeout: 5_000 });
  await expect(receipt).toHaveClass(/show/);
  expect(await stop()).toEqual([Math.round(slid)]);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await layout(page)).sheet.left).toBeCloseTo(before.sheet.left, 0);
});

test('the pin\'s fade waits for the chips beside the sliding column, never showing over them', async ({ page }) => {
  await boot(page, 1100, 760);
  const before = await layout(page);
  await runAndFile(page, 1);
  await expect.poll(async () => (await layout(page)).sheet.left).toBeCloseTo(before.sheet.left, 0);
  await page.locator('#toggle-panel').click();
  await expect(page.locator('#session')).toHaveClass(/floating/);
  // Every frame from the pin's click: the card's opacity and left edge,
  // and the chip's right edge.
  await page.evaluate(() => {
    const probe = window as typeof window & { __frames?: Array<{ o: number; left: number; chip: number }>; __tracing?: boolean };
    probe.__frames = [];
    const card = document.getElementById('session')!;
    const chip = document.querySelector('#sheet .rchip')!;
    const tick = () => {
      if (!probe.__tracing) return;
      probe.__frames!.push({ o: Number(getComputedStyle(card).opacity), left: card.getBoundingClientRect().left, chip: chip.getBoundingClientRect().right });
      requestAnimationFrame(tick);
    };
    document.querySelector('#session [data-mode="pinned"]')!.addEventListener('click', () => {
      probe.__tracing = true;
      requestAnimationFrame(tick);
    }, { capture: true, once: true });
  });
  await page.locator('#session [data-mode="pinned"]').click();
  await expect(page.locator('#session')).toHaveClass(/docked/);
  await expect(page.locator('#sheet')).not.toHaveClass(/slide/);
  await page.locator('#session').evaluate((element) => Promise.all(element.getAnimations().map((a) => a.finished)));
  const frames = await page.evaluate(() => {
    const probe = window as typeof window & { __frames?: Array<{ o: number; left: number; chip: number }>; __tracing?: boolean };
    probe.__tracing = false;
    return probe.__frames!;
  });
  expect(frames.length).toBeGreaterThan(5);
  const showing = frames.filter((f) => f.o > 0.02);
  expect(showing.length).toBeGreaterThan(0);
  for (const f of showing) expect(f.left, `at opacity ${f.o.toFixed(2)}`).toBeGreaterThanOrEqual(f.chip - 1);
});

test('source view by keyboard while a card is up leaves no lean behind: the column comes back centred', async ({ page }) => {
  await float(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, 1100, 760);
  const before = await layout(page);
  await run(page, 0);
  await expect(page.locator('#receipt')).toHaveClass(/show/);
  // A second card while the column is out for the first.
  await run(page, 1);
  await expect(page.locator('#receipt')).toHaveAttribute('data-cell', (await cell(page, 1).getAttribute('data-cell'))!);
  await page.keyboard.press('ControlOrMeta+Shift+KeyE');
  await expect(page.locator('body')).toHaveAttribute('data-view', 'source');
  await page.keyboard.press('ControlOrMeta+Shift+KeyE');
  await expect(page.locator('body')).not.toHaveAttribute('data-view', 'source');
  await expect(page.locator('#receipt')).toBeHidden();
  await expect.poll(async () => (await layout(page)).sheet.left, { timeout: 2_500 }).toBeCloseTo(before.sheet.left, 0);
});

test('a change in place made while runs are queued is credited to no cell, not to the next one', async ({ page }) => {
  await float(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    sessionStorage.setItem('knuth-doc', JSON.stringify({
      name: 'inplace.py',
      dirty: false,
      text: ['# %%', 'prices = read_csv("prices.csv")', '', '# %%', 'time.sleep(0.5)', 'prices["q"] = 1', '', '# %%', 'e = 5', ''].join('\n'),
    }));
  });
  await boot(page);
  await runAndFile(page, 0);
  // The slow cell changes prices in place, which only a snapshot sees;
  // the next is queued behind it, so neither gets a snapshot of its own.
  await run(page, 1);
  await run(page, 2);
  const receipt = page.locator('#receipt');
  await expect(receipt).toHaveAttribute('data-cell', (await cell(page, 2).getAttribute('data-cell'))!);
  await page.waitForTimeout(300);
  await expect(receipt.locator('.r-vars .n')).toHaveText(['e']);
  await page.keyboard.press('Escape');
  await expect(cell(page, 2).locator('.rchip')).toHaveAttribute('title', /^e — /);
  await expect(cell(page, 1).locator('.rchip')).toHaveCount(0);
  // Alone, the same change in place gets its receipt.
  await runAndFile(page, 1);
  await expect(cell(page, 1).locator('.rchip')).toHaveAttribute('title', /^prices — /);
});
