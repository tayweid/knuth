// The session (src/session.ts, docs/SESSION.md): a run's receipt beside the
// cell that flies up into the pill, the chip it leaves at the cell's corner,
// and the Session column the pill's chips open beside the cells (which
// slide left for it), on its Variables, Data or Figures page. The mock engine answers a run the way the real
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
  await expect(pillLit(page)).toHaveCount(0);
}

/** A cell's last receipt, held open from its chip: a run's own card flies
 *  straight up into the pill, so what it says is read here. */
async function held(page: Page, i: number): Promise<Locator> {
  const chip = cell(page, i).locator('.rchip');
  await expect(chip).toBeVisible();
  await chip.click();
  const receipt = page.locator('#receipt');
  await expect(receipt).toHaveAttribute('data-kind', 'held');
  return receipt;
}

const cell = (page: Page, i: number) => page.locator('#sheet .cell-wrap').nth(i);
/** The pill's chips (variables, data, figures) lit, and those blue. */
const pillLit = (page: Page) => page.locator('#session-pill .sp-chip.has');
const pillNew = (page: Page) => page.locator('#session-pill .sp-chip.has.new');
const parts = (locator: Locator) => locator.evaluateAll((chips) => chips.map((chip) => (chip as HTMLElement).dataset.part));
/** A pill chip: opens the Session column on its page, turns to it, or
 *  closes the column when that page shows. */
const chipFor = (page: Page, part: 'session' | 'data' | 'figures') => page.locator(`#session-pill .sp-chip[data-part="${part}"]`);

async function run(page: Page, i: number) {
  await cell(page, i).locator('.run').click();
}

/** Run a cell and wait for its receipt to be filed: the run done, its
 *  card eased in and flown into the pill (0.24 s), the chip at the cell. */
async function runAndFile(page: Page, i: number) {
  const runs = () => page.evaluate(() => (window as Probe).__knuthRuns ?? 0);
  const before = await runs();
  await run(page, i);
  await expect.poll(runs).toBeGreaterThan(before);
  await page.waitForTimeout(400);
  await expect(cell(page, i).locator('.rchip')).toBeVisible();
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
  await expect.poll(() => parts(pillLit(page))).toEqual(['session', 'data']);
  await expect.poll(() => parts(pillNew(page))).toEqual(['session', 'data']);
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
  await expect.poll(() => parts(pillLit(page))).toEqual(['session', 'data']);
  // Landed, its chip comes up under the pointer, whose hover is the chip's.
  await expect(receipt).not.toHaveAttribute('data-kind', 'fresh');
});

test('the flight: the card shrinks into the pill\'s chip for what it made, which lights as it lands', async ({ page }) => {
  await boot(page);
  await run(page, 0);
  await expect(page.locator('#receipt')).toBeVisible();
  // Keep typing: the card flies home.
  await cell(page, 3).locator('.cm-content').click();
  await page.keyboard.type('#');
  await expect(page.locator('#receipt.flying')).toHaveCount(1);
  const mid = await page.locator('#receipt').evaluate((element) => getComputedStyle(element).transform);
  expect(mid).not.toBe('none');
  // A table: home to the Data chip, lit as it lands.
  await expect(page.locator('#session-pill .sp-chip.land')).toHaveAttribute('data-part', 'data');
  await expect(page.locator('#receipt')).toBeHidden();
  await expect.poll(() => parts(pillLit(page))).toEqual(['session', 'data']);
  // A figure: home to the Figures chip.
  await run(page, 1);
  await expect(page.locator('#session-pill .sp-chip.land')).toHaveAttribute('data-part', 'figures');
  await expect.poll(() => parts(pillLit(page))).toEqual(['session', 'data', 'figures']);
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
  // The pill: all three lit, blue where the run's new names are (two
  // Series and the axes), and no names spelled out.
  await expect.poll(() => parts(pillLit(page))).toEqual(['session', 'data', 'figures']);
  await expect.poll(() => parts(pillNew(page))).toEqual(['session', 'data', 'figures']);
  await expect(page.locator('#session-pill')).not.toContainText('demand');

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

test('an edited cell\'s chip is amber; a restart fades the chips and dims the pill\'s, its title saying fresh session', async ({ page }) => {
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
  await expect(pillLit(page)).toHaveCount(0);
  await expect(page.locator('#session-pill')).toHaveAttribute('title', /fresh session/);
  await expect(chip).toHaveClass(/past/);
  await expect.poll(async () => Number(await chip.evaluate((element) => getComputedStyle(element).opacity))).toBeLessThan(0.5);
  // Its cell runs again: the chip comes back.
  await runAndFile(page, 0);
  await expect(chip).not.toHaveClass(/past/);
});

test('a pill chip opens its page in the column beside the cells; the lit chip or ✕ closes it, a click elsewhere or Esc does not', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await runAndFile(page, 0);
  await runAndFile(page, 1);
  const card = page.locator('#session');
  await expect(card).toBeHidden();
  await chipFor(page, 'session').click();
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-page', 'session');
  // All three cards show, the chip's open and the others shrunk.
  await expect(card.locator('.s-part .s-title')).toHaveText(['Variables', 'Data', 'Figures']);
  await expect(card.locator('.s-part.on .s-title')).toHaveText('Variables');
  await expect(chipFor(page, 'session')).toHaveAttribute('aria-pressed', 'true');
  await expect(chipFor(page, 'data')).toHaveAttribute('aria-pressed', 'false');
  // The last run's line on top, then every name with kind and cell.
  await expect(card.locator('.rv .r-head .t')).toHaveText('Last run · cell 2');
  await expect(card.locator('.s-row b')).toHaveText(['prices', 'n', 'demand', 'elasticity', 'ax']);
  await expect(card.locator('.s-row').first().locator('.cl')).toHaveText('cell 1');
  // Opening Variables is looking: the blue goes.
  await expect(pillNew(page)).toHaveCount(0);
  // It is part of the page: a click elsewhere and Esc leave it.
  await page.locator('#doc').click({ position: { x: 200, y: 700 } });
  await page.keyboard.press('Escape');
  await expect(card).toBeVisible();
  // Another chip opens its card, the column where it stands; Variables
  // shrinks to its header and a preview.
  const at = await box(page, '#session');
  await chipFor(page, 'data').click();
  await expect(card).toHaveAttribute('data-page', 'data');
  await expect(card.locator('.s-part.on .s-title')).toHaveText('Data');
  await expect(card.locator('[data-pane="session"]')).toBeVisible();
  await expect(card.locator('[data-pane="data"] .s-pick button')).toHaveText(['prices', 'demand', 'elasticity']);
  expect(await box(page, '#session')).toEqual(at);
  // A click on a shrunk card opens it.
  await card.locator('.s-part[data-part="figures"]').click();
  await expect(card).toHaveAttribute('data-page', 'figures');
  await expect(chipFor(page, 'figures')).toHaveAttribute('aria-pressed', 'true');
  await chipFor(page, 'data').click();
  // The lit chip closes it; so does ✕.
  await chipFor(page, 'data').click();
  await expect(card).toBeHidden();
  await expect(chipFor(page, 'data')).toHaveAttribute('aria-pressed', 'false');
  await chipFor(page, 'figures').click();
  await expect(card).toHaveAttribute('data-page', 'figures');
  await card.locator('.s-close').click();
  await expect(card).toBeHidden();
});

test('a page with nothing in it says what will show there', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await chipFor(page, 'data').click();
  await expect(page.locator('#session [data-pane="data"] .s-note')).toHaveText(/No tables yet/);
  await chipFor(page, 'figures').click();
  await expect(page.locator('#session [data-pane="figures"] .s-note')).toHaveText(/No figures yet/);
  await chipFor(page, 'session').click();
  await expect(page.locator('#session .s-empty .lead')).toHaveText('An empty session');
});

test('the column stands in the frame beside the room, which narrows for it, the cells centred in what is left; a reload keeps its page', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  const before = await layout(page);
  expect(before.sheet.width).toBe(832);
  expect(Math.abs(before.sheet.left - centredLeft(before))).toBeLessThan(1);
  expect(before.room.right).toBe(1500 - 8);
  await chipFor(page, 'session').click();
  const card = page.locator('#session');
  await expect(card).toBeVisible();
  const open = await layout(page);
  // The room gives up the column and one edge: 380 wide at 1500, its
  // right edge on the window's 8 px (the pill's), the room's top and
  // bottom, 8 px past the room.
  expect(open.session.width).toBe(380);
  expect(open.session.right).toBe(1500 - 8);
  expect(open.session.left - open.room.right).toBe(8);
  expect([open.session.top, open.session.bottom]).toEqual([open.room.top, open.room.bottom]);
  expect(await card.evaluate((element) => [element.parentElement?.tagName, getComputedStyle(element).position])).toEqual(['BODY', 'fixed']);
  // The cells keep their width and centre in the narrower room.
  expect(open.sheet.width).toBe(832);
  expect(Math.abs(open.sheet.left - centredLeft(open))).toBeLessThan(1);
  expect(open.sheet.left).toBeLessThan(before.sheet.left - 100);
  // Three panes on the frame, each the room's own grey with its corners
  // and ring, no glass; the column itself draws nothing.
  expect(await card.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  const room = await page.locator('#layout').evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.backgroundColor, style.borderTopLeftRadius, style.boxShadow];
  });
  expect(await card.locator('.s-part').evaluateAll((parts) => parts.map((part) => {
    const style = getComputedStyle(part);
    return [style.backgroundColor, style.borderTopLeftRadius, style.boxShadow];
  }))).toEqual(Array(3).fill(room));
  expect(room[0]).toBe('rgb(43, 42, 45)');
  // A run never moves the cells.
  await run(page, 0);
  await expect(page.locator('#session .rv .r-head .t')).toHaveText('Last run · cell 1');
  expect((await layout(page)).sheet).toEqual(open.sheet);
  // A reload keeps it open on the page it showed.
  await chipFor(page, 'data').click();
  await page.reload();
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(card).toHaveAttribute('data-page', 'data');
  await expect(card).toBeVisible();
  expect((await layout(page)).sheet).toEqual(open.sheet);
  // Closed, the room is whole again, and stays so.
  await card.locator('.s-close').click();
  await expect(card).toBeHidden();
  const closed = await layout(page);
  expect([closed.room, closed.sheet]).toEqual([before.room, before.sheet]);
  await page.reload();
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(card).toBeHidden();
});

test('the column\'s width follows the window, 320 to 380; the room never lies under it, and below the floor it scrolls sideways', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // [window, the column's width]
  for (const [width, side] of [[1470, 380], [1300, 338], [1100, 320]]) {
    await boot(page, width, 820);
    await chipFor(page, 'session').click();
    await expect(page.locator('#session')).toBeVisible();
    const g = await layout(page);
    const at = `at ${width}`;
    expect(Math.round(g.session.width), at).toBe(side);
    expect(g.session.right, at).toBe(width - 8);
    expect(g.session.left - g.room.right, at).toBe(8);
    expect(g.sideways, at).toBe(false);
    // The cells fill what there is, up to their 832, centred.
    expect(g.sheet.width, at).toBe(Math.min(832, Math.round(g.content)));
    expect(Math.abs(g.sheet.left - centredLeft(g)), at).toBeLessThan(1);
    await page.locator('#session .s-close').click();
  }
  // Under the room's floor (a 640 px window's) the room scrolls sideways;
  // the column stays in the frame, beside it.
  await boot(page, 900, 760);
  await chipFor(page, 'session').click();
  const narrow = await layout(page);
  expect(narrow.sideways).toBe(true);
  expect(narrow.session.left - narrow.room.right).toBe(8);
  expect((await box(page, '#session .s-close')).right).toBeLessThanOrEqual(900 - 8);
});

test('the room\'s edge moves over 0.36 s on opening and closing, the column coming in from the right', async ({ page }) => {
  for (const width of [1500, 1100]) {
    await boot(page, width, 760);
    await chipFor(page, 'session').click();
    const sliding = await page.evaluate(() => ({
      on: document.documentElement.classList.contains('session-sliding'),
      duration: getComputedStyle(document.getElementById('layout')!).transitionDuration,
      property: getComputedStyle(document.getElementById('layout')!).transitionProperty,
    }));
    expect(sliding).toEqual({ on: true, duration: '0.36s', property: 'right' });
    const timing = await page.locator('#session').evaluate((element) => element.getAnimations().at(-1)?.effect?.getTiming().duration);
    expect(timing, `at ${width}`).toBe(360);
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('session-sliding'))).toBe(false);
    await page.locator('#session .s-close').click();
    expect(await page.evaluate(() => document.documentElement.classList.contains('session-sliding'))).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('session-sliding'))).toBe(false);
  }
});

test('the column open: a run\'s receipt lands in the Variables page\'s top, with no card beside the cell; the chip still appears', async ({ page }) => {
  await boot(page);
  await chipFor(page, 'session').click();
  await run(page, 1);
  await expect(page.locator('#session .rv .r-head .t')).toHaveText('Last run · cell 2');
  await expect(page.locator('#session .rv')).toHaveClass(/landed/);
  await expect(page.locator('#receipt')).toBeHidden();
  await expect(cell(page, 1).locator('.rchip')).toBeVisible();
  await expect.poll(() => parts(pillLit(page))).toEqual(['session', 'data', 'figures']);
});

test('Run all lays its receipts down as chips, no card, its new names blue', async ({ page }) => {
  await boot(page);
  await page.locator('#run-all').click();
  await expect(cell(page, 3).locator('.rchip')).toBeVisible();
  await expect(page.locator('#receipt')).toBeHidden();
  for (const i of [0, 1, 3]) await expect(cell(page, i).locator('.rchip')).toBeVisible();
  // Program cells only: the scratch cell did not run.
  await expect(cell(page, 2).locator('.rchip')).toHaveCount(0);
  await expect.poll(() => parts(pillNew(page))).toEqual(['session', 'data', 'figures']);
});

test('a table pages in the Data page, and a figure opens in the Figures page', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await runAndFile(page, 0);
  await runAndFile(page, 1);
  await chipFor(page, 'session').click();
  await page.locator('#session .s-row', { hasText: 'prices' }).click();
  await expect(page.locator('#session')).toHaveAttribute('data-page', 'data');
  await expect(chipFor(page, 'data')).toHaveAttribute('aria-pressed', 'true');
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
  // The picker holds every table; the Figures page the figure, as an
  // image; back on Data, the table is where it was.
  await expect(page.locator('#session [data-pane="data"] .s-pick button')).toHaveText(['prices', 'demand', 'elasticity']);
  await chipFor(page, 'figures').click();
  await expect(page.locator('#session [data-pane="figures"] .viewer .figure img')).toBeVisible();
  await chipFor(page, 'data').click();
  await expect(table.locator('tbody tr')).toHaveCount(250);
  await expect(page.locator('#session [data-pane="figures"] .viewer .figure svg')).toHaveCount(0);
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

test('a chip\'s hover never moves the column, nor its click, which opens the receipt over the page', async ({ page }) => {
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
  // for it.
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
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, 1100, 760);
  await cell(page, 3).locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('est = 0');
  await page.keyboard.press('ControlOrMeta+Enter');
  const receipt = await held(page, 3);
  await expect(receipt).toHaveClass(/slim/);
  const row = receipt.locator('tr', { hasText: 'est' });
  await expect(row.locator('.pv')).toHaveText('-0.408882', { useInnerText: true });
  await expect(row.locator('.ty')).toBeHidden();
  await expect(row).toHaveAttribute('title', 'est: float64 · -0.4088817904210866');
  // A wide card shows it whole.
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1700, height: 760 });
  await held(page, 3);
  await expect(receipt).not.toHaveClass(/slim/);
  await expect(receipt.locator('tr', { hasText: 'est' }).locator('.pv')).toHaveText('-0.4088817904210866', { useInnerText: true });
});

test('a run that binds hundreds of names lists eight, says how many more, and Variables has them; its chip reads 99+', async ({ page }) => {
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
  const receipt = await held(page, 1);
  await expect(receipt.locator('.r-vars tr')).toHaveCount(8);
  await expect(receipt.locator('.r-more')).toHaveText('+112 more · in Variables');
  // The whole card in the room.
  const card = await box(page, '#receipt');
  expect(card.bottom).toBeLessThanOrEqual((await box(page, '#layout')).bottom);
  await receipt.locator('.r-more').click();
  await expect(receipt).toBeHidden();
  await expect(page.locator('#session')).toHaveAttribute('data-page', 'session');
  // The caret never left the cell, as with the pill.
  expect(await page.evaluate(() => document.activeElement?.classList.contains('cm-content'))).toBe(true);
  await expect(page.locator('#session .s-list .s-row')).toHaveCount(120);
  // The chip: 99 and a raised +, as narrow as two digits, so the column
  // past the lane never covers it.
  const chip = cell(page, 1).locator('.rchip');
  await expect(chip).toHaveText('99');
  await expect(chip.locator('.n')).toHaveClass(/over/);
  const at = await boxOf(chip);
  const board = await box(page, '#session');
  expect(at.right).toBeLessThanOrEqual(board.left - 1);
  expect(at.width).toBeLessThanOrEqual(38.5);
  // The column has one list: every name the run bound carries its
  // mark there, none listed twice.
  await expect(page.locator('#session .s-row.touched')).toHaveCount(120);
  await expect(page.locator('#session .s-row')).toHaveCount(120);
});

test('a slim card shows a short value in place of its kind, which stays in the tooltip', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, 1100, 760);
  await run(page, 0);
  const receipt = await held(page, 0);
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

test('the pill never grows: three chips say something is there, not what', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, 680, 700);
  const pill = page.locator('#session-pill');
  const width = async () => Math.round((await pill.boundingBox())!.width);
  const empty = await width();
  await expect(page.locator('#session-pill .sp-chip')).toHaveCount(3);
  await page.locator('#run-all').click();
  await expect(cell(page, 3).locator('.rchip')).toBeVisible();
  await expect.poll(() => parts(pillLit(page))).toEqual(['session', 'data', 'figures']);
  expect(await width()).toBe(empty);
  // No names, no counts: the status's words and nothing else.
  expect((await pill.textContent())!.trim()).toBe('Python');
  await expect(pill).toHaveAttribute('title', /6 names, 1 figure/);
});

test('the column open: a chip\'s hover shows its receipt in the Variables band, and a click keeps it there', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await chipFor(page, 'session').click();
  await run(page, 0);
  await expect(cell(page, 0).locator('.rchip')).toBeVisible();
  await run(page, 1);
  const band = page.locator('#session .rv.band');
  await expect(band.locator('.r-head .t')).toHaveText('Last run · cell 2');
  const chip = cell(page, 0).locator('.rchip');
  await chip.hover();
  await expect(band.locator('.r-head .t')).toHaveText('Earlier run · cell 1');
  await expect(band).toHaveClass(/earlier/);
  await expect(page.locator('#session .s-row.touched b')).toHaveText(['prices', 'n']);
  await expect(chip).toHaveClass(/\bon\b/);
  // No card beside the cell.
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
  // A hover while the column shows Data turns to Variables for the band,
  // and back when it ends; the pill's chip stays on Data.
  await page.locator('#session .s-row', { hasText: 'prices' }).click();
  await expect(page.locator('#session')).toHaveAttribute('data-page', 'data');
  await chip.hover();
  await expect(page.locator('#session')).toHaveAttribute('data-page', 'session');
  await expect(band.locator('.r-head .t')).toHaveText('Earlier run · cell 1');
  await page.mouse.move(300, 850);
  await expect(page.locator('#session')).toHaveAttribute('data-page', 'data');
  await page.reload();
  await expect(page.locator('#session')).toHaveAttribute('data-page', 'data');
});

test('one list: the band names the run, the names it touched carry its marks, and the band goes to its cell', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await chipFor(page, 'session').click();
  await run(page, 0);
  const band = page.locator('#session .rv.band');
  await expect(band.locator('.r-head .t')).toHaveText('Last run · cell 1');
  await expect(page.locator('#session .s-row.touched b')).toHaveText(['prices', 'n']);
  await expect(page.locator('#session .s-row.touched .m')).toHaveText(['+', '+']);
  await run(page, 1);
  await expect(band.locator('.r-head .t')).toHaveText('Last run · cell 2');
  await expect(page.locator('#session .s-row.touched b')).toHaveText(['demand', 'elasticity', 'ax']);
  await expect(page.locator('#session .s-row b')).toHaveText(['prices', 'n', 'demand', 'elasticity', 'ax']);
  // No second copy of the names, no folder line.
  await expect(page.locator('#session .b-row, #session .r-folder, #session .s-sec')).toHaveCount(0);
  await band.locator('.r-head').click();
  await expect(cell(page, 1).locator('.cm-editor')).toHaveClass(/cm-focused/);
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
  await expect(chipFor(page, 'session')).toHaveAttribute('aria-disabled', 'true');
  await expect(chipFor(page, 'session')).toHaveAttribute('title', /switch to cell view/);
  await chipFor(page, 'session').click({ force: true });
  await expect(page.locator('#session')).toBeHidden();
  await expect(pill).not.toHaveClass(/open/);
  // The status still reads, and the names are there.
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await page.locator('#view-toggle').click();
  await expect(pill).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('#session')).toBeHidden();
  await chipFor(page, 'session').click();
  await expect(page.locator('#session')).toBeVisible();
  // Open, the column hides in source view and comes back with the cells.
  await page.locator('#view-toggle').click();
  await expect(page.locator('#session')).toBeHidden();
  await page.locator('#view-toggle').click();
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
  const receipt = await held(page, 3);
  await expect(receipt.locator('.r-vars .n')).toHaveText(['prices']);
  await expect(receipt.locator('.r-vars .m')).toHaveText(['~']);
  await expect(receipt.locator('.r-vars .m')).toHaveAttribute('title', /in place/);
  await expect(receipt.locator('.r-vars .ty')).toHaveText(['DataFrame 250×3']);
});

test('Esc in a cell puts a card away, and the next Esc is command mode; the column is not a card, and Esc passes it by', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await cell(page, 3).locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(() => parts(pillLit(page))).toEqual(['session']);
  // A chip's receipt, kept: Esc puts it away, the cell keeping the cursor.
  await cell(page, 3).locator('.rchip').click();
  await expect(page.locator('#receipt')).toHaveAttribute('data-kind', 'held');
  await page.keyboard.press('Escape');
  await expect(page.locator('#receipt')).toBeHidden();
  await expect(cell(page, 3).locator('.cell')).not.toHaveClass(/selected/);
  await page.keyboard.press('Escape');
  await expect(cell(page, 3).locator('.cell')).toHaveClass(/selected/);
  // The column, from the pill: the caret stays in the cell, and Esc is
  // the cell's.
  await cell(page, 3).locator('.cm-content').click();
  await chipFor(page, 'session').click();
  await expect(page.locator('#session')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#session')).toBeVisible();
  await expect(cell(page, 3).locator('.cell')).toHaveClass(/selected/);
  await page.keyboard.press('s');
  await expect(cell(page, 3).locator('.cell')).toHaveClass(/kind-scratch/);
  await expect.poll(() => parts(pillLit(page))).toEqual(['session']);
});

/** "31 ms", "0.80 s": a receipt's time, in ms. */
const msOf = (text: string) => (text.endsWith(' ms') ? parseFloat(text) : parseFloat(text) * 1000);

test('runs queued behind a busy kernel credit each cell with its own names, and time each run alone', async ({ page }) => {
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
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __knuthRuns?: number }).__knuthRuns)).toBe(3);
  const receipt = await held(page, 2);
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
  // Variables says which cell bound each, so "go there" goes there.
  await chipFor(page, 'session').click();
  const where = (name: string) => page.locator('#session .s-row', { has: page.locator('b', { hasText: new RegExp(`^${name}$`) }) }).locator('.cl');
  await expect(where('a')).toHaveText('cell 1');
  await expect(where('b')).toHaveText('cell 2');
  await expect(where('c')).toHaveText('cell 2');
  await expect(where('d')).toHaveText('cell 3');
});

test('a change in place made while runs are queued is credited to no cell, not to the next one', async ({ page }) => {
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
  await page.waitForTimeout(800);
  const receipt = await held(page, 2);
  await expect(receipt.locator('.r-vars .n')).toHaveText(['e']);
  await page.keyboard.press('Escape');
  await expect(cell(page, 2).locator('.rchip')).toHaveAttribute('title', /^e — /);
  await expect(cell(page, 1).locator('.rchip')).toHaveCount(0);
  // Alone, the same change in place gets its receipt.
  await runAndFile(page, 1);
  await expect(cell(page, 1).locator('.rchip')).toHaveAttribute('title', /^prices — /);
});

test('Variables, Data and Figures are three cards: the open one takes the height, the others shrink to a preview, and the move is animated', async ({ page }) => {
  await boot(page, 1500, 760);
  await page.locator('#run-all').click();
  await expect(cell(page, 3).locator('.rchip')).toBeVisible();
  const card = page.locator('#session');
  const part = (tab: string) => card.locator(`.s-part[data-part="${tab}"]`);
  const pane = (tab: string) => card.locator(`[data-pane="${tab}"]`);
  const room = await box(page, '#layout');
  const heights = () => card.locator('.s-part').evaluateAll((parts) => parts.map((p) => Math.round(p.getBoundingClientRect().height)));
  await chipFor(page, 'session').click();
  await expect(card).toBeVisible();
  await card.evaluate((element) => Promise.allSettled(element.getAnimations({ subtree: true }).map((a) => a.finished)));
  for (const tab of ['session', 'data', 'figures'] as const) {
    if (tab !== 'session') {
      await chipFor(page, tab).click();
      // The cards move to their new heights rather than jump.
      expect(await card.evaluate((element) => [...element.querySelectorAll('.s-part')].every((p) => p.getAnimations().length === 1))).toBe(true);
      await card.evaluate((element) => Promise.allSettled(element.getAnimations({ subtree: true }).map((a) => a.finished)));
    }
    for (const other of ['session', 'data', 'figures']) {
      await expect(pane(other)).toBeVisible();
      if (other === tab) await expect(part(other)).toHaveClass(/\bon\b/);
      else await expect(part(other)).not.toHaveClass(/\bon\b/);
    }
    // The shrunk ones are 136 px at the most; the three and their gaps
    // fill the column, the room's height.
    const h = await heights();
    const open = ['session', 'data', 'figures'].indexOf(tab);
    h.forEach((height, i) => {
      if (i !== open) expect(height, `${tab}: card ${i}`).toBeLessThanOrEqual(136);
    });
    expect(h[open]).toBeGreaterThan(300);
    const column = await box(page, '#session');
    expect(Math.round(column.bottom - column.top)).toBe(Math.round(room.bottom - room.top));
    expect(Math.abs(h.reduce((a, b) => a + b, 0) + 16 - (column.bottom - column.top))).toBeLessThanOrEqual(2);
  }
  // Each card holds its own: the names, the tables, the figure.
  await expect(pane('session').locator('.s-row')).toHaveCount(6);
  await chipFor(page, 'data').click();
  await pane('data').locator('.s-pick button', { hasText: 'prices' }).click();
  await expect(pane('data').locator('.data-table')).toBeVisible();
  await expect(pane('figures').locator('.viewer .figure img')).toBeVisible();
  // No folds, no pin: a card's header is its name, the top one's ✕ the
  // column's.
  await expect(card.locator('.s-fold, .s-pin')).toHaveCount(0);
  await expect(card.locator('.s-close')).toHaveCount(1);
  await expect(part('session').locator('.s-close')).toHaveCount(1);
});

test('Knuth.app\'s View › Zoom draws the column larger in a measure widened by as much, nothing round it moving; the Session column keeps beside it; remembered', async ({ page }) => {
  // The stand-in shell (0.2.11): Chromium's zoom held at 1, the View
  // menu's steps sent to the page as `zoom {step}`.
  await page.addInitScript(() => {
    const listeners = new Set<(detail: unknown) => void>();
    (window as unknown as { __zoom: (step: number) => void }).__zoom = (step) => listeners.forEach((listener) => listener({ step }));
    Object.defineProperty(window, 'claerbout', {
      configurable: true,
      value: {
        request: async () => null,
        on: (event: string, listener: (detail: unknown) => void) => {
          if (event !== 'zoom') return () => {};
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await page.evaluate(() => localStorage.removeItem('knuth-column-zoom'));
  const zoom = (step: number) => page.evaluate((step) => (window as unknown as { __zoom: (step: number) => void }).__zoom(step), step);
  const frame = () => Promise.all(['#toolbar', '#rail', '#layout', '#session-pill', '#doc'].map((selector) => box(page, selector)));
  const lineHeight = () => boxOf(page.locator('#sheet .cm-line')).then((b) => b.bottom - b.top);
  const before = await layout(page);
  const frameBefore = await frame();
  const lineBefore = await lineHeight();
  expect(before.sheet.width).toBe(832);

  // In two steps: 125%, the measure 1040 px and centred, the code drawn
  // 1.25 as tall, the bar, the rail, the room and the pill where they were.
  await zoom(1);
  await expect(page.locator('#toast')).toHaveText('Zoom 110%');
  await zoom(1);
  await expect(page.locator('#toast')).toHaveText('Zoom 125%');
  const zoomed = await layout(page);
  expect(zoomed.sheet.width).toBe(1040);
  expect(Math.abs(zoomed.sheet.left - centredLeft(zoomed))).toBeLessThan(1);
  expect((await lineHeight()) / lineBefore).toBeCloseTo(1.25, 1);
  expect(await frame()).toEqual(frameBefore);

  // A click lands on the character drawn under it: CodeMirror reads the
  // zoomed column's coordinates.
  const target = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('#sheet .cm-line')];
    const index = lines.findIndex((el) => (el.textContent ?? '').length >= 6);
    const line = lines[index];
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode() as Text;
    const range = document.createRange();
    range.setStart(text, 3);
    range.setEnd(text, 4);
    const r = range.getBoundingClientRect();
    return { index, x: r.left + 1, y: (r.top + r.bottom) / 2, before: line.textContent ?? '', at: (line.textContent ?? '').indexOf(text.data) + 3 };
  });
  await page.mouse.click(target.x, target.y);
  await page.keyboard.type('Q');
  await expect(page.locator('#sheet .cm-line').nth(target.index)).toHaveText(target.before.slice(0, target.at) + 'Q' + target.before.slice(target.at));
  await page.keyboard.press('Backspace');

  // The Session column open, the zoomed cells stay inside the narrower
  // room, the column in the frame beside it.
  await chipFor(page, 'session').click();
  await expect(page.locator('#session')).toBeVisible();
  const docked = await layout(page);
  expect(docked.session.left - docked.room.right).toBe(8);
  expect(docked.sheet.right).toBeLessThanOrEqual(docked.room.right);
  expect(docked.sheet.width).toBeGreaterThanOrEqual(800);
  await page.locator('#session .s-close').click();

  // Out to 90%, remembered across a reload; Actual Size is the 52rem.
  await zoom(-1);
  await zoom(-1);
  await zoom(-1);
  await expect(page.locator('#toast')).toHaveText('Zoom 90%');
  await page.reload();
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  expect(Math.abs((await layout(page)).sheet.width - 832 * 0.9)).toBeLessThan(1);
  await zoom(0);
  await expect(page.locator('#toast')).toHaveText('Zoom 100%');
  // Where it stood and as wide (its height is the edited document's).
  const home = (await layout(page)).sheet;
  expect([home.left, home.width, home.top]).toEqual([before.sheet.left, before.sheet.width, before.sheet.top]);
});
