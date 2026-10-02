// The scroll rail (src/scroll-rail.ts, Plass's rail; src/rail-marks.ts,
// Knuth's marks): the whole document in a 20 px gutter of the frame at the
// window's right, there while the column runs past the room in the cell
// view. The room gives the gutter 12 px of its width (W − 64 wide with it,
// W − 52 without); the column keeps its own width rules. The marks are
// placed by fraction of the room's scroll height down a track the room's
// height: headings in text cells as dots by level, code cells as ticks (red
// when the last run raised, pulsing while it runs), figures as filled
// squares and tables (a run that left a DataFrame) as open ones, the
// cursor's cell as the blue bar. The mock engine answers a run as
// session.spec's does (what a cell bound, a figure for `.plot(`), raises
// for a cell with `raise` in it (history.spec's message), and takes
// `sleep(s)` seconds.
import { expect, test, type Page } from '@playwright/test';

const FIGURE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140" viewBox="0 0 240 140"><rect width="240" height="140" fill="#fff"/><path d="M20 30 L120 80 L220 115" fill="none" stroke="#305c8a" stroke-width="3"/></svg>';
const RAIL = 44;
const EDGE = 8;
const GUTTER = 20;

const PROSE = 'The price of a cup moves the queue more than the weather does, and the morning rush hides most of it from anyone who only counts the till.';
const prose = (n: number) => `# ${Array.from({ length: n }, () => PROSE).join(' ')}`;
const filler = (name: string, n: number) => Array.from({ length: n }, (_, i) => `${name}_${i} = ${i * 7}`);

/** A notebook of five text cells and twelve code cells, about three rooms
 *  tall at 1100 × 760: a # title, ## and ### headings, a cell that reads a
 *  table (prices, a DataFrame), one that plots, one that raises, one that
 *  sleeps. */
const NOTEBOOK = [
  '# %% [markdown]', '# # Demand for coffee', '#', prose(2), '',
  '# %%', 'prices = read_csv("prices.csv")', 'n = 1200', '',
  '# %% [markdown]', '# ## The data', '#', prose(3), '',
  '# %%', 'demand = prices.groupby("price").quantity.median()', 'ax = demand.plot(marker="o")', '',
  '# %%', ...filler('a', 6), '',
  '# %% [markdown]', '# ### Elasticity', '#', prose(2), '',
  '# %%', 'elasticity = demand.pct_change()', 'fit = estimate(elasticity, raise_on_empty=True)', '',
  '# %%', ...filler('b', 7), '',
  '# %% [markdown]', '# ## Results', '#', prose(3), '',
  '# %%', 'wait = sleep(1.5)', ...filler('c', 4), '',
  '# %%', ...filler('d', 8), '',
  '# %%', ...filler('e', 6), '',
  '# %% [markdown]', '# ### Robustness', '#', prose(2), '',
  '# %%', ...filler('f', 7), '',
  '# %%', ...filler('g', 6), '',
  '# %%', ...filler('h', 8), '',
  '# %%', ...filler('k', 5), '',
].join('\n');

/** Two cells: it fits the room at any usual window. */
const SHORT = '# %% [markdown]\n# ## Notes\n\n# %%\nx = 1\n';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((figureSvg) => {
    const KINDS: Record<string, Record<string, unknown>> = {
      prices: { type: 'DataFrame', shape: [250, 2], preview: '     price  quantity\n0   0.5  812' },
      demand: { type: 'Series', length: 3, preview: 'price 0.5 812.0 1.0 410.0 1.5 190.0' },
      ax: { type: 'Axes', preview: "<Axes: xlabel='price'>", figure: true },
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
        this.queue = this.queue.then(() => this.handle(msg));
      }

      private async handle(msg: Record<string, unknown>) {
        if (msg.type === 'attach') {
          this.reply({ type: 'attached', protocol: msg.protocol, session: msg.session, resumed: false });
          this.reply({ type: 'ready' });
        } else if (msg.type === 'restart') {
          this.ns.clear();
          this.reply({ type: 'ready', id: msg.id });
        } else if (msg.type === 'run') {
          const code = String(msg.code);
          const sleep = /sleep\(([\d.]+)\)/.exec(code);
          await new Promise((done) => window.setTimeout(done, sleep ? Number(sleep[1]) * 1000 : 30));
          if (/raise/.test(code)) {
            this.reply({ type: 'error', id: msg.id, traceback: 'Traceback (most recent call last):\n  File "<cell>", line 2\nValueError: no fit' });
            return;
          }
          const bound: Array<Record<string, unknown>> = [];
          for (const line of code.split('\n')) {
            const match = /^(\w+)\s*=\s*(.*)$/.exec(line.trim());
            if (!match) continue;
            const [, name, value] = match;
            const entry = { name, ...(KINDS[name] ?? { type: 'int', preview: value, saved: true }) } as Record<string, unknown>;
            this.ns.set(name, entry);
            bound.push(entry);
          }
          if (code.includes('.plot(')) this.reply({ type: 'figures', id: msg.id, svgs: [figureSvg], named: ['ax'] });
          this.reply({ type: 'done', id: msg.id, result: null, bound });
        } else if (msg.type === 'namespace') {
          const vars = [...this.ns.values()].map(({ saved: _saved, ...entry }) => entry);
          this.reply({ type: 'namespace', id: msg.id, vars });
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
    // Silent: no receipt card beside a cell, so a run moves nothing sideways.
    localStorage.setItem('knuth-receipts', 'silent');
  }, FIGURE_SVG);
});

/** The document for this page, kept across a reload (the stash's own key). */
async function seed(page: Page, text: string, name = 'demand.py') {
  await page.addInitScript(({ text, name }) => {
    if (!sessionStorage.getItem('knuth-doc')) sessionStorage.setItem('knuth-doc', JSON.stringify({ name, dirty: false, text }));
  }, { text, name });
}

async function boot(page: Page, text = NOTEBOOK, width = 1100, height = 760, name = 'demand.py') {
  await seed(page, text, name);
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');
}

const cell = (page: Page, i: number) => page.locator('#sheet .cell-wrap').nth(i);
/** The code cells' wraps, by their number as the receipt counts them. */
const codeCell = (page: Page, n: number) => page.locator('#sheet .cell-wrap:has(> .cell.kind-program)').nth(n - 1);

async function runCell(page: Page, n: number) {
  await codeCell(page, n).locator('.run').click();
}

const hasRail = (page: Page) => page.evaluate(() => document.documentElement.classList.contains('has-rail'));

/** The frame's state: the gutter, the rail, the room's box. */
const frame = (page: Page) =>
  page.evaluate(() => {
    const r = document.getElementById('layout')!.getBoundingClientRect();
    return {
      gutter: document.documentElement.classList.contains('has-rail'),
      railShown: getComputedStyle(document.getElementById('scrollrail')!).display !== 'none',
      room: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    };
  });

/** Where things should be on the rail, from the cells (their tops in the
 *  room's scroll px over its scroll height, down the track), and where the
 *  rail drew them, in track px. */
const geometry = (page: Page, tableCells: number[] = []) =>
  page.evaluate((tableCells) => {
    const doc = document.getElementById('doc')!;
    const d = doc.getBoundingClientRect();
    const H = doc.scrollHeight;
    const track = document.querySelector('#scrollrail .sr-track')!.getBoundingClientRect();
    const at = (el: Element, bottom = false) => {
      const r = el.getBoundingClientRect();
      return (bottom ? r.bottom : r.top) - d.top - doc.clientTop + doc.scrollTop;
    };
    const toTrack = (y: number) => (y / H) * track.height;
    const want = (selector: string) => [...document.querySelectorAll(`#sheet ${selector}`)].map((el) => toTrack(at(el)));
    const drawn = (selector: string) =>
      [...document.querySelectorAll(`#scrollrail ${selector}`)]
        .map((el) => {
          const r = el.getBoundingClientRect();
          return r.top + r.height / 2 - track.top;
        })
        .sort((a, b) => a - b);
    // A table: the top of the cell's readout, or with none the cell's end.
    const codeRows = [...document.querySelectorAll('#sheet .cell.kind-program')];
    const tables = tableCells.map((n) => {
      const row = codeRows[n - 1];
      const out = row.querySelector<HTMLElement>('.output:not([hidden])');
      return toTrack(out ? at(out) : at(row, true));
    });
    return {
      track: { top: track.top, height: track.height, left: track.left, right: track.right },
      scrollHeight: H,
      want: {
        title: want('.kind-text .ProseMirror h1'),
        section: want('.kind-text .ProseMirror h2'),
        subsection: want('.kind-text .ProseMirror :is(h3, h4, h5, h6)'),
        code: want('.cell:is(.kind-program, .kind-scratch)'),
        figure: want('.cell-figures .figure'),
        table: tables,
      },
      drawn: {
        title: drawn('.sr-title'),
        section: drawn('.sr-section'),
        subsection: drawn('.sr-subsection'),
        code: drawn('.sr-code'),
        figure: drawn('.sr-figure'),
        table: drawn('.sr-table'),
      },
      targets: [...document.querySelectorAll('#scrollrail .sr-mark')].map((el) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2 - track.top;
      }),
    };
  }, tableCells);

const scroller = (page: Page) =>
  page.evaluate(() => {
    const p = document.getElementById('doc')!;
    return { top: p.scrollTop, height: p.scrollHeight, client: p.clientHeight };
  });

const label = (page: Page) =>
  page.evaluate(() => {
    const el = document.getElementById('sr-label')!;
    const r = el.getBoundingClientRect();
    const part = (c: string) => el.querySelector(`.${c}`)?.textContent ?? null;
    return {
      shown: el.classList.contains('show'),
      quiet: el.classList.contains('quiet'),
      code: el.classList.contains('code'),
      err: !!el.querySelector('.t.err'),
      k: part('k'),
      t: part('t'),
      p: part('p'),
      box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    };
  });

/** A code cell's row top against the room's top edge, on screen. */
const landed = (page: Page, n: number) =>
  codeCell(page, n).locator(':scope > .cell').evaluate((row) => row.getBoundingClientRect().top - document.getElementById('doc')!.getBoundingClientRect().top);

/** A row's top in the room's scroll px. */
const rowTop = (page: Page, n: number) =>
  codeCell(page, n).locator(':scope > .cell').evaluate((row) => {
    const doc = document.getElementById('doc')!;
    return row.getBoundingClientRect().top - doc.getBoundingClientRect().top - doc.clientTop + doc.scrollTop;
  });

test('the gutter and the rail are there while the column runs past the room, never on a short document or in the source and grid views', async ({ page }) => {
  await boot(page);
  await expect.poll(() => hasRail(page)).toBe(true);
  let f = await frame(page);
  expect(f.railShown).toBe(true);
  // The room 12 px narrower at the right, its other edges where they were;
  // the track the room's height, in the gutter.
  expect(f.room).toEqual({ left: RAIL, top: 44, right: 1100 - GUTTER, bottom: 760 - EDGE });
  const g = await geometry(page);
  expect(g.track).toEqual({ top: 44, height: 760 - 44 - EDGE, left: 1100 - GUTTER, right: 1100 });
  // The session pill keeps the bar's 8 px (it does not move with the rail).
  expect((await page.locator('#session-pill').boundingBox())!.x + (await page.locator('#session-pill').boundingBox())!.width).toBe(1100 - EDGE);
  // The room draws no scrollbar of its own in the cell view.
  expect(await page.locator('#doc').evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe('none');
  // What sits on the room's right edge follows it: the onboarding covers
  // the room only, and the toast stands on the room's axis.
  expect(await page.locator('#onboarding').evaluate((el) => getComputedStyle(el).right)).toBe(`${GUTTER}px`);
  await runCell(page, 3);
  await expect(page.locator('#toast')).toBeVisible();
  const toast = (await page.locator('#toast').boundingBox())!;
  expect(Math.abs(toast.x + toast.width / 2 - (RAIL + 1100 - GUTTER) / 2)).toBeLessThan(1);

  // The source view: one editor, no cells, no rail, the 8 px edge; back,
  // and the rail returns.
  await page.locator('#view-toggle').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'source');
  await expect.poll(() => hasRail(page)).toBe(false);
  f = await frame(page);
  expect(f.railShown).toBe(false);
  expect(f.room.right).toBe(1100 - EDGE);
  expect(await page.locator('#doc').evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe('auto');
  await page.locator('#view-toggle').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', '');
  await expect.poll(() => hasRail(page)).toBe(true);
  expect((await frame(page)).room.right).toBe(1100 - GUTTER);

  // A short document fits the room: the frame's 8 px edge, no rail.
  await page.evaluate((text) => sessionStorage.setItem('knuth-doc', JSON.stringify({ name: 'notes.py', dirty: false, text })), SHORT);
  await page.reload();
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(page.locator('#sheet .cell-wrap')).toHaveCount(2);
  await page.waitForTimeout(150);
  f = await frame(page);
  expect(f).toEqual({ gutter: false, railShown: false, room: { left: RAIL, top: 44, right: 1100 - EDGE, bottom: 760 - EDGE } });

  // A long .csv is its grid (its own scroller), and then its source: no
  // rail in either.
  const csv = ['city,index', ...Array.from({ length: 400 }, (_, i) => `city ${i},${(i % 7) / 10}`)].join('\n') + '\n';
  await page.evaluate((text) => sessionStorage.setItem('knuth-doc', JSON.stringify({ name: 'cities.csv', dirty: false, text })), csv);
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'grid');
  await page.waitForTimeout(150);
  expect(await frame(page)).toEqual({ gutter: false, railShown: false, room: { left: RAIL, top: 44, right: 1100 - EDGE, bottom: 760 - EDGE } });
  await page.locator('#view-toggle').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'source');
  await page.waitForTimeout(150);
  expect((await frame(page)).gutter).toBe(false);
});

test('the room\'s box with the rail and without, at 1100 and 1500, the floor still a 640 px window, and the pinned Session card beside the column with the rail there', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, SHORT);
  for (const [width, height] of [[1100, 760], [1500, 940]]) {
    await page.setViewportSize({ width, height });
    await expect.poll(async () => (await frame(page)).room.right).toBe(width - EDGE);
    expect(await frame(page)).toEqual({ gutter: false, railShown: false, room: { left: RAIL, top: 44, right: width - EDGE, bottom: height - EDGE } });
  }
  await page.evaluate((text) => sessionStorage.setItem('knuth-doc', JSON.stringify({ name: 'demand.py', dirty: false, text })), NOTEBOOK);
  await page.reload();
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  for (const [width, height] of [[1100, 760], [1500, 940]]) {
    await page.setViewportSize({ width, height });
    await expect.poll(async () => (await frame(page)).room.right).toBe(width - GUTTER);
    expect(await frame(page)).toEqual({ gutter: true, railShown: true, room: { left: RAIL, top: 44, right: width - GUTTER, bottom: height - EDGE } });
    // The column keeps its measure: 832 px, centred in what the room has.
    const column = await page.evaluate(() => {
      const doc = document.getElementById('doc')!;
      const style = getComputedStyle(doc);
      const sheet = document.getElementById('sheet')!.getBoundingClientRect();
      const left = doc.getBoundingClientRect().left + doc.clientLeft + parseFloat(style.paddingLeft);
      const content = doc.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return { width: sheet.width, offset: Math.abs(sheet.left + sheet.width / 2 - (left + content / 2)) };
    });
    expect(column.width).toBe(832);
    expect(column.offset).toBeLessThan(1);
  }

  // Pinned, the Session card docks inside the room beside the column (it
  // slides the column, not the frame): past the chips' lane, 10 px in from
  // the room's right edge, which is the gutter's.
  await page.locator('#toggle-panel').click();
  await page.locator('#session [data-mode="pinned"]').click();
  await expect(page.locator('#session')).toHaveClass(/docked/);
  const pinned = await page.evaluate(() => {
    const card = document.getElementById('session')!.getBoundingClientRect();
    const sheet = document.getElementById('sheet')!.getBoundingClientRect();
    const room = document.getElementById('layout')!.getBoundingClientRect();
    return { gap: card.left - sheet.right, right: room.right - card.right, inRoom: document.getElementById('layout')!.contains(document.getElementById('session')), rail: document.documentElement.classList.contains('has-rail') };
  });
  expect(pinned.rail).toBe(true);
  expect(pinned.inRoom).toBe(true);
  expect(Math.abs(pinned.gap - 46)).toBeLessThan(1);
  expect(pinned.right).toBeGreaterThanOrEqual(10 - 0.5);
  expect((await frame(page)).room.right).toBe(1500 - GUTTER);
  await page.locator('#session [data-mode="peek"]').click();

  // The floor: the room still scrolls sideways under a 640 px window, not
  // 652; with the gutter the column bottoms out 12 px narrower, at 536.
  const sideways = () => page.locator('#layout').evaluate((el) => el.scrollWidth > el.clientWidth);
  await page.setViewportSize({ width: 640, height: 700 });
  await expect.poll(() => hasRail(page)).toBe(true);
  await expect.poll(sideways).toBe(false);
  expect(await page.locator('#sheet').evaluate((el) => el.getBoundingClientRect().width)).toBe(536);
  await page.setViewportSize({ width: 639, height: 700 });
  await expect.poll(sideways).toBe(true);
});

test('marks sit at the cells\' tops: headings by level, a tick per code cell, a figure and a table from a run, and they follow the column as outputs arrive', async ({ page }) => {
  await boot(page);
  await expect.poll(() => hasRail(page)).toBe(true);
  const check = async (figures: number, tables: number[]) => {
    const g = await geometry(page, tables);
    expect(g.want.title.length).toBe(1);
    expect(g.want.section.length).toBe(2);
    expect(g.want.subsection.length).toBe(2);
    expect(g.want.code.length).toBe(12);
    expect(g.want.figure.length).toBe(figures);
    expect(g.want.table.length).toBe(tables.length);
    for (const kind of ['title', 'section', 'subsection', 'code', 'figure', 'table'] as const) {
      expect(g.drawn[kind].length, kind).toBe(g.want[kind].length);
      g.want[kind].forEach((y, i) => expect(Math.abs(g.drawn[kind][i] - y), `${kind} ${i}: drawn ${g.drawn[kind][i]}, at ${y}`).toBeLessThan(1));
    }
    return g;
  };
  const before = await check(0, []);
  // The table's cell (prices, a DataFrame), then the figure's (which also
  // leaves demand, a Series: a column, no table): the figure (240 × 140
  // and its card) pushes every cell under it down, and the marks follow.
  await runCell(page, 1);
  await expect(codeCell(page, 1).locator('.rchip.kind-table')).toHaveCount(1);
  await runCell(page, 2);
  await expect(page.locator('.cell-figures .figure')).toHaveCount(1);
  await expect.poll(async () => (await geometry(page)).drawn.figure.length).toBe(1);
  await expect.poll(async () => (await geometry(page)).drawn.table.length).toBe(1);
  const after = await check(1, [1]);
  expect(after.scrollHeight).toBeGreaterThan(before.scrollHeight + 140);
  expect(after.drawn.code.at(-1)!).toBeGreaterThan(before.drawn.code.at(-1)! + 1);
  // The title is a 7 px dot, a section 5, a subsection 3, a tick 7 × 1, a
  // square 5.
  const sizes = await page.evaluate(() =>
    Object.fromEntries(['title', 'section', 'subsection', 'code', 'figure', 'table'].map((k) => {
      const el = document.querySelector(`#scrollrail .sr-${k}`) as HTMLElement;
      return [k, [el.offsetWidth, el.offsetHeight]];
    })));
  expect(sizes).toEqual({ title: [7, 7], section: [5, 5], subsection: [3, 3], code: [7, 1], figure: [5, 5], table: [5, 5] });

  // Wider: the column rewraps (the prose cells grow shorter), and the marks
  // are read again at the new offsets.
  await page.setViewportSize({ width: 1500, height: 760 });
  await expect.poll(async () => (await frame(page)).room.right).toBe(1500 - GUTTER);
  await page.waitForTimeout(100);
  await check(1, [1]);
});

test('a run that raised turns its tick red, a running cell\'s tick pulses, and the label says what was raised', async ({ page }) => {
  await boot(page);
  await expect.poll(() => hasRail(page)).toBe(true);
  // Cell 4 raises.
  await runCell(page, 4);
  await expect(codeCell(page, 4).locator('.output.error')).toBeVisible();
  await expect(page.locator('#scrollrail .sr-code.error')).toHaveCount(1);
  // (Past the tick's 0.12 s colour change.)
  await expect.poll(() => page.locator('#scrollrail .sr-code.error').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(205, 100, 82)');
  const red = await page.evaluate(() => {
    const el = document.querySelector('#scrollrail .sr-code.error') as HTMLElement;
    const style = getComputedStyle(el);
    const track = document.querySelector('#scrollrail .sr-track')!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { colour: style.backgroundColor, opacity: style.opacity, y: r.top + r.height / 2 - track.top, size: [el.offsetWidth, el.offsetHeight] };
  });
  expect(red.colour).toBe('rgb(205, 100, 82)');
  expect(red.opacity).toBe('1');
  expect(red.size).toEqual([9, 2]);
  const g = await geometry(page);
  expect(Math.abs(red.y - g.want.code[3])).toBeLessThan(1);
  await page.mouse.move(1100 - GUTTER / 2, g.track.top + red.y);
  await expect.poll(async () => (await label(page)).shown).toBe(true);
  expect(await label(page)).toMatchObject({ k: 'Cell 4', t: 'ValueError: no fit', err: true, code: true });
  await page.mouse.move(600, 400);

  // Cell 6 sleeps 1.5 s: its tick pulses in the run control's green, then
  // stops.
  await runCell(page, 6);
  await expect(page.locator('#scrollrail .sr-code.running')).toHaveCount(1);
  await expect.poll(() => page.locator('#scrollrail .sr-code.running').evaluate((el) => ({ name: getComputedStyle(el).animationName, colour: getComputedStyle(el).backgroundColor })))
    .toEqual({ name: 'sr-pulse', colour: 'rgb(110, 165, 118)' });
  await expect(page.locator('#scrollrail .sr-code.running')).toHaveCount(0, { timeout: 5_000 });
  // The raised cell stays red until it runs cleanly.
  await expect(page.locator('#scrollrail .sr-code.error')).toHaveCount(1);
});

test('the cursor\'s cell is the blue bar, and it moves with a click into another cell', async ({ page }) => {
  await boot(page);
  await expect.poll(() => hasRail(page)).toBe(true);
  const bar = () =>
    page.evaluate(() => {
      const el = document.querySelector('#scrollrail .sr-caret') as HTMLElement | null;
      if (!el) return null;
      const track = document.querySelector('#scrollrail .sr-track')!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { y: r.top + r.height / 2 - track.top, colour: getComputedStyle(el).backgroundColor };
    });
  const inTrack = async (y: number) => {
    const g = await geometry(page);
    return (y / g.scrollHeight) * g.track.height;
  };
  await codeCell(page, 2).locator('.cm-content').click();
  await expect.poll(async () => {
    const b = await bar();
    return b ? Math.abs(b.y - (await inTrack(await rowTop(page, 2)))) : 99;
  }).toBeLessThan(1);
  expect((await bar())!.colour).toBe('rgb(157, 184, 214)');
  // Further down: scroll it into view and click into it.
  await codeCell(page, 9).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await codeCell(page, 9).locator('.cm-content').click();
  await expect.poll(async () => {
    const b = await bar();
    return b ? Math.abs(b.y - (await inTrack(await rowTop(page, 9)))) : 99;
  }).toBeLessThan(1);
});

test('the label names a heading by its words and a code cell by its number and first line, and stays inside the window', async ({ page }) => {
  await boot(page);
  await expect.poll(() => hasRail(page)).toBe(true);
  const g = await geometry(page);
  const x = 1100 - GUTTER / 2;
  const inside = (box: { left: number; top: number; right: number; bottom: number }) => {
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(760);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(1100 - GUTTER);
  };
  // "## The data": its words in the bar's serif, no lead.
  await page.mouse.move(x, g.track.top + g.drawn.section[0]);
  await expect.poll(async () => (await label(page)).shown).toBe(true);
  let l = await label(page);
  expect({ k: l.k, t: l.t, p: l.p, quiet: l.quiet, code: l.code }).toEqual({ k: null, t: 'The data', p: null, quiet: false, code: false });
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#sr-label .t')!).fontFamily)).toMatch(/^"STIX Two Text"/);
  inside(l.box);
  // The title.
  await page.mouse.move(x, g.track.top + g.drawn.title[0]);
  await expect.poll(async () => (await label(page)).t).toBe('Demand for coffee');
  // Cell 1: "Cell 1" and its first line, in mono.
  await page.mouse.move(x, g.track.top + g.drawn.code[0]);
  await expect.poll(async () => (await label(page)).k).toBe('Cell 1');
  l = await label(page);
  expect({ t: l.t, code: l.code }).toEqual({ t: 'prices = read_csv("prices.csv")', code: true });
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#sr-label .t')!).fontFamily)).toMatch(/monospace|SF Mono|Menlo/);
  inside(l.box);
  // A line typed into Cell 1's first line is the label's next time.
  await page.mouse.move(600, 400);
  await codeCell(page, 1).locator('.cm-line').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('  # read');
  await page.mouse.move(x, g.track.top + g.drawn.code[0]);
  // (Runs of spaces read as one, as every label's words do.)
  await expect.poll(async () => (await label(page)).t).toBe('prices = read_csv("prices.csv") # read');
  // Empty track: a faint line, and the cell or the section that point is in.
  let empty = -1;
  for (let y = 30; y < g.track.height - 30; y++) {
    if (g.targets.every((t) => Math.abs(t - y) > 10)) {
      empty = y;
      break;
    }
  }
  expect(empty).toBeGreaterThan(0);
  await page.mouse.move(x, g.track.top + empty);
  await expect.poll(async () => (await label(page)).quiet).toBe(true);
  expect(await page.evaluate(() => document.querySelector('#scrollrail .sr-ghost')!.classList.contains('show'))).toBe(true);
  expect((await label(page)).t).toMatch(/^(Cell \d+|Demand for coffee|The data|Elasticity|Results|Robustness)$/);
  // The track's very ends keep the label inside the window.
  for (const y of [0.5, g.track.height - 0.5]) {
    await page.mouse.move(x, g.track.top + y);
    await expect.poll(async () => (await label(page)).shown).toBe(true);
    inside((await label(page)).box);
  }
  // Leaving the gutter puts it away, and the band sleeps after.
  await page.mouse.move(600, 400);
  await expect.poll(async () => (await label(page)).shown).toBe(false);
});

test('a click on a mark puts its cell\'s top an eighth of the way down the room; a drag scrubs and jumps nothing; the wheel scrolls the room', async ({ page }) => {
  await boot(page);
  await expect.poll(() => hasRail(page)).toBe(true);
  const g = await geometry(page);
  const x = 1100 - GUTTER / 2;
  // Cell 5's tick.
  const { client } = await scroller(page);
  await page.mouse.click(x, g.track.top + g.drawn.code[4]);
  // Where it landed, once the scroll's end has put right what the cells
  // measured on the way moved (CodeMirror lays a cell far off screen out
  // from an estimate; here Cell 4 is 3 px shorter once seen).
  await expect.poll(async () => Math.abs((await landed(page, 5)) - client / 8)).toBeLessThan(1.5);
  expect(Math.abs((await scroller(page)).top - ((await rowTop(page, 5)) - client / 8))).toBeLessThan(1.5);
  // A heading: "## Results".
  await page.mouse.click(x, g.track.top + g.drawn.section[1]);
  const results = await page.locator('#sheet .ProseMirror h2').nth(1).evaluate((h) => {
    const doc = document.getElementById('doc')!;
    return h.getBoundingClientRect().top - doc.getBoundingClientRect().top + doc.scrollTop;
  });
  await expect.poll(async () => Math.abs((await scroller(page)).top - (results - client / 8))).toBeLessThan(1.5);

  // A press on a mark that drags scrubs the band from where it was: 100 px
  // of drag is 100 / the track's height of the document, and nothing
  // jumps.
  await page.evaluate(() => (document.getElementById('doc')!.scrollTop = 0));
  await page.waitForTimeout(100);
  const start = await scroller(page);
  const from = g.track.top + g.drawn.code[0];
  await page.mouse.move(x, from);
  await page.mouse.down();
  await page.mouse.move(x, from + 50, { steps: 5 });
  await page.mouse.move(x, from + 100, { steps: 5 });
  expect(await page.evaluate(() => document.getElementById('scrollrail')!.classList.contains('dragging'))).toBe(true);
  await page.mouse.up();
  const expected = start.top + (100 / g.track.height) * start.height;
  const dragged = (await scroller(page)).top;
  expect(Math.abs(dragged - expected)).toBeLessThan(2);
  await page.waitForTimeout(600);
  expect((await scroller(page)).top).toBe(dragged);

  // The wheel over the gutter scrolls the room, which the gutter is not in.
  await page.mouse.move(x, g.track.top + 300);
  const before = (await scroller(page)).top;
  await page.mouse.wheel(0, 240);
  await expect.poll(async () => (await scroller(page)).top - before).toBe(240);
});

test('the band is the visible span: the room\'s scrollTop and height over its scroll height; lit while the pointer is in the gutter and 0.9 s after a scroll', async ({ page }) => {
  await boot(page);
  await expect.poll(() => hasRail(page)).toBe(true);
  const track = (await geometry(page)).track;
  for (const at of [0, 0.25, 0.6, 1]) {
    const s = await page.evaluate((at) => {
      const p = document.getElementById('doc')!;
      p.scrollTop = (p.scrollHeight - p.clientHeight) * at;
      return { top: p.scrollTop, height: p.scrollHeight, client: p.clientHeight };
    }, at);
    const want = { top: (s.top / s.height) * track.height, height: Math.max(10, (s.client / s.height) * track.height) };
    await expect
      .poll(async () => {
        const band = await page.evaluate(() => document.querySelector('#scrollrail .sr-band')!.getBoundingClientRect());
        return Math.max(Math.abs(band.top - track.top - want.top), Math.abs(band.height - want.height));
      }, { message: `at ${at}` })
      .toBeLessThan(0.6);
  }
  // At the end the band's bottom is level with the room's bottom.
  const band = await page.evaluate(() => document.querySelector('#scrollrail .sr-band')!.getBoundingClientRect());
  expect(Math.abs(band.bottom - (760 - EDGE))).toBeLessThan(0.6);

  const lit = () => page.evaluate(() => {
    const r = document.getElementById('scrollrail')!;
    return { moving: r.classList.contains('moving'), awake: r.classList.contains('awake') };
  });
  await expect.poll(lit, { timeout: 3_000 }).toEqual({ moving: false, awake: false });
  await page.evaluate(() => document.getElementById('doc')!.scrollBy(0, -200));
  await expect.poll(async () => (await lit()).moving).toBe(true);
  await expect.poll(async () => (await lit()).moving, { timeout: 3_000 }).toBe(false);
  await page.mouse.move(1100 - GUTTER / 2, 300);
  await expect.poll(async () => (await lit()).awake).toBe(true);
  await expect.poll(() => page.locator('#scrollrail .sr-band').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(255, 255, 255, 0.075)');
  await page.mouse.move(600, 300);
  await expect.poll(async () => (await lit()).awake, { timeout: 3_000 }).toBe(false);
});

test('a scroll writes the band and the `in` of what it crosses, and a keystroke that keeps the column\'s height writes nothing to the rail', async ({ page }) => {
  await boot(page);
  await expect.poll(() => hasRail(page)).toBe(true);
  // Through the document once first: CodeMirror measures a cell as it
  // comes into view (a few px against its estimate), which is the column
  // settling, and moves the marks under it. The scrolls below are over a
  // column that has settled.
  for (let top = 0; top < (await scroller(page)).height; top += 400) {
    await page.evaluate((t) => (document.getElementById('doc')!.scrollTop = t), top);
    await page.waitForTimeout(80);
  }
  await page.evaluate(() => (document.getElementById('doc')!.scrollTop = 0));
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const w = window as unknown as { __rail: string[] };
    w.__rail = [];
    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        w.__rail.push(`${el.id || el.className.replace(/ ?\b(in|hot|moving|awake)\b/g, '')}:${r.attributeName ?? r.type}`);
      }
    }).observe(document.getElementById('scrollrail')!, { subtree: true, attributes: true, childList: true });
  });
  const writes = () => page.evaluate(() => [...new Set((window as unknown as { __rail: string[] }).__rail)]);
  const clear = () => page.evaluate(() => ((window as unknown as { __rail: string[] }).__rail = []));
  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // Down the room a step at a time: the band's style, and the class of a
  // mark the band passed; nothing else.
  const { height, client } = await scroller(page);
  for (const at of [0.1, 0.4, 0.8]) {
    await page.evaluate((top) => (document.getElementById('doc')!.scrollTop = top), (height - client) * at);
    await frames();
  }
  const w = await writes();
  expect(w).toContain('sr-band:style');
  expect(w.filter((x) => x !== 'sr-band:style' && x !== 'scrollrail:class' && !/^sr-mark\b.*:class$/.test(x))).toEqual([]);
  // The marks inside the band carry `in`, the rest not.
  const wrong = await page.evaluate(() => {
    const p = document.getElementById('doc')!;
    const f0 = p.scrollTop / p.scrollHeight;
    const f1 = (p.scrollTop + p.clientHeight) / p.scrollHeight;
    return [...document.querySelectorAll<HTMLElement>('#scrollrail .sr-mark')].filter((el) => {
      const f = parseFloat(el.style.getPropertyValue('--f'));
      return Math.abs(f - f0) > 1e-4 && Math.abs(f - f1) > 1e-4 && (f > f0 && f < f1) !== el.classList.contains('in');
    }).length;
  });
  expect(wrong).toBe(0);

  // Typing in a line that stays one line: no write on the rail.
  await codeCell(page, 3).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await codeCell(page, 3).locator('.cm-line').first().click();
  await page.keyboard.press('End');
  // Once the column has settled from the scroll and the click (a cell
  // measured as it came into view, the cursor's bar) and the band has gone
  // quiet after the scroll (0.9 s), a quiet 250 ms.
  await expect.poll(() => page.evaluate(() => document.getElementById('scrollrail')!.classList.contains('moving')), { timeout: 3_000 }).toBe(false);
  await expect.poll(async () => {
    await clear();
    await page.waitForTimeout(250);
    return (await writes()).length;
  }).toBe(0);
  await page.keyboard.type('1234', { delay: 40 });
  await frames();
  await page.waitForTimeout(100);
  expect(await writes()).toEqual([]);
  // A new line is the column settling: the marks under it move.
  await page.keyboard.press('Enter');
  await page.keyboard.type('z = 1');
  await expect.poll(async () => (await writes()).some((x) => /^sr-mark sr-code.*:style$/.test(x))).toBe(true);
});

test('the keyboard: one tab stop, Up and Down between marks with the label following, Home and End, Return jumps', async ({ page }) => {
  await boot(page);
  await expect.poll(() => hasRail(page)).toBe(true);
  const marks = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#scrollrail .sr-mark')]
      .map((b) => ({ label: b.getAttribute('aria-label'), tab: b.tabIndex, y: b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2 }))
      .sort((a, b) => a.y - b.y));
  expect(marks.filter((m) => m.tab === 0).length).toBe(1);
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
  await page.locator('#scrollrail .sr-mark[tabindex="0"]').focus();
  expect(await focused()).toBe(marks[0].label);
  expect(marks[0].label).toBe('Demand for coffee');
  await expect.poll(async () => (await label(page)).shown).toBe(true);
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe(marks[1].label);
  await page.keyboard.press('End');
  expect(await focused()).toBe(marks.at(-1)!.label);
  expect((await label(page)).k).toBe('Cell 12');
  await page.keyboard.press('Home');
  expect(await focused()).toBe(marks[0].label);
  expect(await page.evaluate(() => document.querySelectorAll('#scrollrail .sr-mark[tabindex="0"]').length)).toBe(1);
  // Down to Cell 5, then Return: its top an eighth of the way down.
  for (let i = 0; i < marks.length && !(await focused())?.startsWith('Cell 5,'); i++) await page.keyboard.press('ArrowDown');
  expect(await focused()).toMatch(/^Cell 5, b_0 = 0$/);
  expect(await label(page)).toMatchObject({ shown: true, k: 'Cell 5', t: 'b_0 = 0' });
  const { client } = await scroller(page);
  await page.keyboard.press('Enter');
  await expect.poll(async () => Math.abs((await landed(page, 5)) - client / 8)).toBeLessThan(1.5);
  // Tab leaves the rail and the label goes.
  await page.keyboard.press('Shift+Tab');
  await expect.poll(async () => (await label(page)).shown).toBe(false);
});

test('nothing opens or grows while a mouse button is down: a selection dragged from a cell\'s text into the gutter', async ({ page }) => {
  await boot(page);
  await expect.poll(() => hasRail(page)).toBe(true);
  const g = await geometry(page);
  const x = 1100 - GUTTER / 2;
  const rail = () =>
    page.evaluate(() => {
      const r = document.getElementById('scrollrail')!;
      return {
        awake: r.classList.contains('awake'),
        dragging: r.classList.contains('dragging'),
        hot: r.querySelectorAll('.hot').length,
        label: document.getElementById('sr-label')!.classList.contains('show'),
        ghost: r.querySelector('.sr-ghost')!.classList.contains('show'),
      };
    });
  // From the prose of "The data" out over a heading's mark.
  const p = await cell(page, 2).locator('.ProseMirror p').first().boundingBox();
  await page.mouse.move(p!.x + 20, p!.y + 8);
  await page.mouse.down();
  await page.mouse.move(900, p!.y + 30, { steps: 6 });
  await page.mouse.move(x, g.track.top + g.drawn.section[0], { steps: 6 });
  await page.mouse.move(x, g.track.top + g.drawn.section[0] + 1, { steps: 2 });
  expect(await rail()).toEqual({ awake: false, dragging: false, hot: 0, label: false, ghost: false });
  await page.mouse.up();
  // Released there, a hover opens the label as usual.
  await page.mouse.move(x, g.track.top + g.drawn.section[0]);
  await expect.poll(async () => (await rail()).label).toBe(true);
});

test('on a long notebook the code cells\' ticks thin so the ones drawn stay 4 px apart, and a red tick is always drawn', async ({ page }) => {
  test.setTimeout(90_000);
  // 240 one-line cells: about 2.9 px apart on a 708 px track.
  const cells = Array.from({ length: 240 }, (_, i) => `# %%\n${i === 121 ? 'v = estimate(raise_on_empty=True)' : `v_${i} = ${i}`}\n`).join('\n');
  await boot(page, `# %% [markdown]\n# # A long notebook\n\n${cells}`);
  await expect.poll(() => hasRail(page)).toBe(true);
  const ticks = () =>
    page.evaluate(() => {
      const track = document.querySelector('#scrollrail .sr-track')!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>('#scrollrail .sr-code')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { y: r.top + r.height / 2 - track.top, drawn: getComputedStyle(el).visibility === 'visible', red: el.classList.contains('error') };
        })
        .sort((a, b) => a.y - b.y);
    });
  await expect.poll(async () => (await ticks()).length).toBe(240);
  let t = await ticks();
  const drawn = t.filter((k) => k.drawn);
  expect(drawn.length).toBeGreaterThan(100);
  expect(drawn.length).toBeLessThan(240);
  for (let i = 1; i < drawn.length; i++) expect(drawn[i].y - drawn[i - 1].y).toBeGreaterThanOrEqual(4 - 0.01);
  // Cell 122 raises: its tick is drawn whatever is beside it.
  await codeCell(page, 122).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await runCell(page, 122);
  await expect(page.locator('#scrollrail .sr-code.error')).toHaveCount(1);
  t = await ticks();
  expect(t.filter((k) => k.red)).toEqual([expect.objectContaining({ drawn: true })]);
});
