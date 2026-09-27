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
