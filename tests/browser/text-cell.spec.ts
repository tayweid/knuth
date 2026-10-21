import { expect, test } from '@playwright/test';

// A trimmed mock of app.spec.ts's engine socket: these tests only need the
// app to reach a ready status pill, never to run a cell or fetch a figure.
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
          this.readyState = MockWebSocket.OPEN;
          this.dispatchEvent(new Event('open'));
        });
      }

      send(raw: string) {
        const msg = JSON.parse(raw);
        if (msg.type === 'attach') {
          this.reply({ type: 'attached', protocol: msg.protocol, session: msg.session, resumed: false });
          this.reply({ type: 'ready' });
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

function seed(page: import('@playwright/test').Page, text: string) {
  return page.addInitScript((t) => {
    sessionStorage.setItem('knuth-doc', JSON.stringify({ name: 'notes.py', dirty: false, text: t }));
  }, text);
}

// One text cell (a heading, bold prose, and inline math) between two
// program cells — the trailing "#"/"# " prefixing is the on-disk percent
// format (src/format/percent.ts); the rendered/edited text is the prose
// with that prefix stripped.
const DOC_TEXT = `# %%
x = 1

# %% [markdown]
# # Heading
#
# **bold** prose with $x^2$ math.

# %%
y = 2
`;

const EMPTY_TEXT_DOC = `# %%
x = 1

# %% [markdown]

# %%
y = 2
`;

test('a text cell is editable straight away: no rendered/edit split', async ({ page }) => {
  await seed(page, DOC_TEXT);
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');

  const prose = page.locator('.cell.kind-text .ProseMirror');
  await expect(prose).toBeVisible();
  await expect(prose.locator('h1')).toHaveText('Heading');
  await expect(prose.locator('strong')).toHaveText('bold');
  await expect(prose.locator('.katex').first()).toBeVisible();

  // Clicking straight into the rendered heading edits it in place — there
  // is no raw-markdown mode to switch into.
  await prose.locator('h1').click();
  await expect(prose).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await expect(prose.locator('h1')).toHaveText('Heading!');
});

test('an empty text cell shows its placeholder, not an overlay', async ({ page }) => {
  await seed(page, EMPTY_TEXT_DOC);
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');

  const prose = page.locator('.cell.kind-text .ProseMirror');
  await expect(prose).toBeVisible();
  await expect(prose.locator('[data-placeholder]')).toHaveAttribute('data-placeholder', 'Write…');
});

test('typing "# " renders a live heading', async ({ page }) => {
  await seed(page, EMPTY_TEXT_DOC);
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');

  const prose = page.locator('.cell.kind-text .ProseMirror');
  await prose.click();
  await page.keyboard.type('# Title ');
  await expect(prose.locator('h1')).toHaveText('Title');
});

test('typing "**bold**" renders live strong', async ({ page }) => {
  await seed(page, EMPTY_TEXT_DOC);
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');

  const prose = page.locator('.cell.kind-text .ProseMirror');
  await prose.click();
  await page.keyboard.type('**bold**');
  await expect(prose.locator('strong')).toHaveText('bold');
});

test('inline math renders as a katex atom; clicking it opens the popover with the source', async ({ page }) => {
  await seed(page, DOC_TEXT);
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');

  const atom = page.locator('.cell.kind-text .ProseMirror .math-inline');
  await expect(atom.locator('.katex')).toBeVisible();
  await atom.click();

  const input = page.locator('.math-editor-input');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('x^2');
});

test('a single click into prose places a cursor', async ({ page }) => {
  await seed(page, DOC_TEXT);
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');

  const prose = page.locator('.cell.kind-text .ProseMirror');
  await prose.locator('h1').click();
  const active = await page.evaluate(() => document.activeElement?.closest('.ProseMirror') !== null);
  expect(active).toBe(true);
});

test('ArrowDown from a code cell focuses the text cell below; ArrowUp returns', async ({ page }) => {
  await seed(page, DOC_TEXT);
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');

  const code = page.locator('.cell.kind-program .cm-content').first();
  const prose = page.locator('.cell.kind-text .ProseMirror');

  // The first program cell is a single line — any click lands on its
  // (only, so also last) line.
  await code.click();
  await page.keyboard.press('ArrowDown');
  await expect(prose).toBeFocused();

  await page.keyboard.press('ArrowUp');
  await expect(code).toBeFocused();
});

test('an edit lands in the session stash as "# "-prefixed markdown', async ({ page }) => {
  await seed(page, DOC_TEXT);
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');

  const prose = page.locator('.cell.kind-text .ProseMirror');
  await prose.locator('text=math.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' more.');
  await expect(prose).toContainText('more.');

  await expect(async () => {
    const stash = await page.evaluate(() => {
      const raw = sessionStorage.getItem('knuth-doc');
      return raw ? (JSON.parse(raw) as { text: string }).text : null;
    });
    expect(stash).toMatch(/^# .*more\./m);
  }).toPass();
});

test('Cmd/Ctrl-click a link opens it in a new tab', async ({ page, context }) => {
  await seed(
    page,
    '# %%\nx = 1\n\n# %% [markdown]\n# [example](https://example.org)\n\n# %%\ny = 2\n',
  );
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');

  const link = page.locator('.cell.kind-text .ProseMirror a');
  await expect(link).toHaveText('example');

  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    link.click({ modifiers: [modifier] }),
  ]);
  expect(popup.url()).toContain('example.org');
});

test('source view shows no ProseMirror text cell', async ({ page }) => {
  await seed(page, DOC_TEXT);
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(page.locator('.cell.kind-text .ProseMirror')).toBeVisible();

  // Source view is one raw editor over the whole file — the cell-view-only
  // ProseMirror instance is torn down, not merely hidden.
  await page.locator('#view-toggle').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'source');
  await expect(page.locator('.ProseMirror')).toHaveCount(0);
});

// Three text cells in a row, then code, then a text cell on its own.
const JOINED_DOC = `# %% [markdown]
# # Demand
#
# The first paragraph.

# %% [markdown]
# A second text cell, the next paragraph.

# %% [markdown]
# ## Method
#
# A third, under a heading.

# %%
n = 3

# %% [markdown]
# After the code.
`;

test('text cells in a row read as one text: a paragraph\'s break between them, the inserter in it; others keep their gap', async ({ page }) => {
  await seed(page, JOINED_DOC);
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  await expect(page.locator('.cell.kind-text')).toHaveCount(4);
  const gaps = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#sheet .cell-wrap > .cell')];
    return rows.slice(1).map((row, i) => Math.round(row.getBoundingClientRect().top - rows[i].getBoundingClientRect().bottom));
  });
  // Text to text: 11 px, 0.6em of the 18 px prose, as two paragraphs in
  // one cell; text to code and code to text keep the 22 px gap.
  expect(gaps).toEqual([11, 11, 22, 22]);
  // Inside one cell the same break.
  const inCell = await page.locator('.cell.kind-text').first().evaluate((cell) => {
    const p = cell.querySelector('p')!;
    return Math.round(parseFloat(getComputedStyle(p).marginTop));
  });
  expect(inCell).toBe(11);
  // A heading starting a joined cell keeps its space above.
  const method = await page.locator('.cell.kind-text').nth(2).evaluate((cell) => {
    const h = cell.querySelector('h2')!.getBoundingClientRect().top;
    return Math.round(h - cell.getBoundingClientRect().top);
  });
  expect(method).toBeGreaterThan(8);
  // The seam's inserter: there, and shown under the pointer.
  const seam = page.locator('#sheet .cell-wrap').nth(1).locator(':scope > .insert-zone');
  await seam.hover();
  await expect(seam.locator('.insert-actions')).toBeVisible();
  await seam.locator('.k-text').click();
  await expect(page.locator('.cell.kind-text')).toHaveCount(5);
});

test('a text cell is marked by a bar down its left side: grey under the pointer, blue inside it, with a wash in command mode', async ({ page }) => {
  await seed(page, JOINED_DOC);
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');
  const cell = page.locator('.cell.kind-text').nth(1);
  const bar = () => cell.evaluate((element) => {
    const style = getComputedStyle(element, '::before');
    return { opacity: style.opacity, color: style.backgroundColor, width: style.width };
  });
  await page.mouse.move(900, 700);
  await expect.poll(bar).toMatchObject({ opacity: '0', width: '3px' });
  await cell.hover();
  await expect.poll(bar).toEqual({ opacity: '1', color: 'rgba(255, 255, 255, 0.18)', width: '3px' });
  await cell.locator('.ProseMirror').click();
  await page.mouse.move(900, 700);
  await expect.poll(bar).toEqual({ opacity: '1', color: 'rgba(157, 184, 214, 0.85)', width: '3px' });
  // The bar is the cell's own height, and the old ticks above and below
  // are gone.
  const heights = await cell.evaluate((element) => {
    const prose = getComputedStyle(element.querySelector('.ProseMirror')!, '::before').content;
    return { prose, cell: Math.round(element.getBoundingClientRect().height) };
  });
  expect(heights.prose).toBe('none');
  // Command mode: the bar, a wash, and no ring.
  await page.keyboard.press('Escape');
  await expect(cell).toHaveClass(/selected/);
  const look = () => cell.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineStyle, wash: style.backgroundColor };
  });
  await expect.poll(look).toEqual({ outline: 'none', wash: 'rgba(157, 184, 214, 0.06)' });
  await expect.poll(bar).toEqual({ opacity: '1', color: 'rgba(157, 184, 214, 0.85)', width: '3px' });
});
