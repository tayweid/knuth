import { expect, test } from '@playwright/test';

// A trimmed mock of app.spec.ts's engine socket: these tests only need the
// app to reach "kernel" status, never to run a cell or fetch a figure.
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

test.beforeEach(async ({ page }) => {
  await page.addInitScript((text) => {
    sessionStorage.setItem('knuth-doc', JSON.stringify({ name: 'notes.py', dirty: false, text }));
  }, DOC_TEXT);
});

test('a text cell renders prose unfocused, edits raw markdown on click, and re-renders on blur', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('kernel');

  const textRender = page.locator('.cell.kind-text .text-render');
  const textEditor = page.locator('.cell.kind-text .cm-content');

  // Unfocused (a loaded document renders immediately): prose is visible,
  // the raw editor is not.
  await expect(textRender).toBeVisible();
  await expect(textRender.locator('h1')).toHaveText('Heading');
  await expect(textRender.locator('strong')).toHaveText('bold');
  await expect(textRender.locator('.katex').first()).toBeVisible();
  await expect(textEditor).toBeHidden();

  // Click swaps to the editor: raw markdown, focused, prose hidden.
  await textRender.click();
  await expect(textEditor).toBeVisible();
  await expect(textRender).toBeHidden();
  await expect(textEditor).toContainText('**bold** prose');
  await expect(textEditor).toBeFocused();

  // Edit the raw markdown...
  await page.keyboard.press('End');
  await page.keyboard.type(' and more.');

  // ...then blur by clicking a code cell: the rendered view comes back,
  // reflecting the edit.
  await page.locator('.cell.kind-program .cm-content').first().click();
  await expect(textRender).toBeVisible();
  await expect(textEditor).toBeHidden();
  await expect(textRender).toContainText('and more.');
});

test('an empty text cell stays in editor mode', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('knuth-doc', JSON.stringify({
      name: 'notes.py',
      dirty: false,
      text: '# %%\nx = 1\n\n# %% [markdown]\n\n# %%\ny = 2\n',
    }));
  });
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('kernel');

  // Nothing to render: the placeholder editor shows, not an empty overlay.
  await expect(page.locator('.cell.kind-text .text-render')).toBeHidden();
  await expect(page.locator('.cell.kind-text .cm-content')).toBeVisible();
});

test('source view shows no rendered prose', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('kernel');
  await expect(page.locator('.cell.kind-text .text-render')).toBeVisible();

  await page.locator('#view-toggle').click();
  await expect(page.locator('body')).toHaveAttribute('data-view', 'source');
  // Source view's one editor is a plain-program pseudo-cell, which still
  // carries a (hidden) .text-render node — the CSS rule under test is
  // what keeps it off-screen regardless.
  await expect(page.locator('.text-render:visible')).toHaveCount(0);
});
