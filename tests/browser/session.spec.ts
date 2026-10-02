// The session (src/session.ts, docs/SESSION.md): a run's receipt beside the
// cell that flies up into the pill, the chip it leaves at the cell's corner,
// and the Session card from the pill — floating, docked, its three modes and
// its Data and Figures tabs. The mock engine answers a run the way the real
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
  await expect(receipt.locator('.r-hint')).toContainText('keep typing to put it away');
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
  await expect(card.locator('.rv .r-head .t')).toHaveText('Cell 2 · last run');
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

test('the pin docks it beside the column, the column\'s width unchanged, and a reload keeps it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  const before = await box(page, '#sheet');
  await page.locator('#session-pill').click();
  await page.locator('#session [data-mode="pinned"]').click();
  const card = page.locator('#session');
  await expect(card).toHaveClass(/docked/);
  await expect(page.locator('#session [data-mode="pinned"]')).toHaveAttribute('aria-checked', 'true');
  const sheet = await box(page, '#sheet');
  expect(sheet).toEqual(before);
  const at = await box(page, '#session');
  // Beside the column, past the chips' lane, inside the room.
  expect(at.left).toBeGreaterThanOrEqual(sheet.right + 40);
  expect(at.right).toBeLessThanOrEqual((await box(page, '#layout')).right);
  // A click elsewhere leaves it; so does Esc.
  await page.locator('#doc').click({ position: { x: 200, y: 700 } });
  await page.keyboard.press('Escape');
  await expect(card).toBeVisible();
  await page.reload();
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(card).toHaveClass(/docked/);
  expect(await box(page, '#sheet')).toEqual(before);
  // Unpinned, it floats again.
  await page.locator('#session [data-mode="peek"]').click();
  await expect(card).toHaveClass(/floating/);
  await page.locator('#session .s-close').click();
  await expect(card).toBeHidden();
  await page.reload();
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(card).toBeHidden();
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
  await expect(page.locator('#session .rv .r-head .t')).toHaveText('Cell 2 · last run');
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
  expect(requests.map((r) => r.offset)).toEqual([0, 100, 200]);
  // The picker holds every table; the Figures tab the figure, as an image.
  await expect(page.locator('#session [data-pane="data"] .s-pick button')).toHaveText(['prices', 'demand', 'elasticity']);
  await page.locator('#session [data-tab="figures"]').click();
  await expect(page.locator('#session [data-pane="figures"] .viewer .figure img')).toBeVisible();
  await expect(page.locator('#session [data-pane="figures"] .viewer .figure svg')).toHaveCount(0);
});

test('on a narrow room the card lies over the room\'s edge, and the chip tucks into the corner when the lane is gone', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, 1100, 760);
  const before = await box(page, '#sheet');
  await run(page, 0);
  await expect(page.locator('#receipt')).toHaveClass(/show/);
  const card = await box(page, '#receipt');
  const room = await box(page, '#layout');
  expect(Math.round(room.right - card.right)).toBe(12);
  expect(await box(page, '#sheet')).toEqual(before);
  await page.keyboard.press('Escape');
  const chip = await boxOf(cell(page, 0).locator('.rchip'));
  expect(chip.left).toBeGreaterThan(before.right);
  // Under the chips' lane, the chip sits inside the cell's corner.
  await page.setViewportSize({ width: 900, height: 760 });
  const sheet = await box(page, '#sheet');
  const tight = await boxOf(cell(page, 0).locator('.rchip'));
  expect(tight.right).toBeLessThanOrEqual(sheet.right);
  expect(await page.locator('#layout').evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
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
  await page.keyboard.press('End');
  await page.keyboard.type('p');
  await expect(page.locator('#receipt')).toBeHidden();
  await expect(cell(page, 3).locator('.cm-content')).toHaveText('k = 3p');
});
