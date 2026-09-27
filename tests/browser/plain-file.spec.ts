import { expect, test } from '@playwright/test';

// A trimmed mock of app.spec.ts's engine socket: these tests only need the
// app to reach a ready status pill, never to run a cell.
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

function seed(page: import('@playwright/test').Page, name: string, text: string) {
  return page.addInitScript(
    ({ name, text }) => {
      sessionStorage.setItem('knuth-doc', JSON.stringify({ name, dirty: false, text }));
    },
    { name, text },
  );
}

const YAML = 'name: knuth\nversion: 3\nlist:\n  - one\n  - two\n# a comment\n';

test('a .yaml file is highlighted, folded, and guided in the plain editor', async ({ page }) => {
  await seed(page, 'config.yaml', YAML);
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');

  const editor = page.locator('.cm-content');
  await expect(editor).toContainText('name: knuth');
  await expect(page.locator('body')).toHaveAttribute('data-view', 'source');
  // Highlighting wraps tokens in spans; a plain text file has none.
  await expect(editor.locator('.cm-line span').first()).toBeVisible();
  await expect(page.locator('.cm-foldGutter')).toBeVisible();
  await expect(page.locator('.cm-indent-markers').first()).toBeVisible();
});

test('a .txt file stays numbered, wrapped text', async ({ page }) => {
  await seed(page, 'notes.txt', 'name: knuth\nversion: 3\n');
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');

  const editor = page.locator('.cm-content');
  await expect(editor).toContainText('name: knuth');
  await expect(page.locator('.cm-lineNumbers')).toBeVisible();
  await expect(editor.locator('.cm-line span')).toHaveCount(0);
  await expect(page.locator('.cm-foldGutter')).toHaveCount(0);
});

const QMD = `---
title: "A report"
format: html
---

# Heading

Some *prose* with a [link](https://example.com).

\`\`\`{python}
import numpy as np
x = np.arange(3)
\`\`\`
`;

test('a .qmd file is markdown with YAML front matter and Python fences', async ({ page }) => {
  await seed(page, 'report.qmd', QMD);
  await page.goto('/');
  await expect(page.locator('#kernel-status')).toHaveText('Python');

  const editor = page.locator('.cm-content');
  await expect(editor).toContainText('# Heading');
  // The front matter is YAML, the fence is Python, the prose is markdown:
  // each gets its own tokens (a plain file has no spans at all).
  const line = (text: string) => editor.locator('.cm-line', { hasText: text });
  await expect(line('title:').locator('span').first()).toBeVisible();
  await expect(line('import numpy').locator('span', { hasText: 'import' })).toBeVisible();
  await expect(line('# Heading').locator('span').first()).toBeVisible();
  await expect(line('*prose*').locator('span').first()).toBeVisible();
});
