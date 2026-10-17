// Takes the README's screenshots (docs/images/*.png) from a small demo
// document, run with Python in the tab (Pyodide), so no engine is needed.
// Run it whenever the app's look changes:
//
//   npm run dev                       (in another terminal)
//   npm run screenshots
//
// KNUTH_URL points it at another server (default http://127.0.0.1:5198).
// The first run downloads Pyodide and matplotlib, so it takes a minute.

import { chromium, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const url = process.env.KNUTH_URL ?? 'http://127.0.0.1:5198';
const out = 'docs/images';

// The README's own example, with a figure of it.
const DEMO = `# %% [markdown]
# # Growth
# The yearly rate we report in the paper, from three years of GDP.

# %%
gdp = [100, 103, 106.2]
rate = round(gdp[-1] / gdp[0] - 1, 3)
rate

# %%
import matplotlib.pyplot as plt

growth, ax = plt.subplots(figsize=(6, 2.6))
ax.plot([2023, 2024, 2025], gdp, marker="o")
ax.set_xticks([2023, 2024, 2025])
ax.set_ylabel("GDP")
ax.grid(alpha=0.3)
`;

const cell = (page: Page, i: number) => page.locator('#sheet .cell-wrap').nth(i);

// The demo document, run top to bottom, its figure drawn.
async function open(width: number, height: number): Promise<Page> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.addInitScript((text) => {
    if (sessionStorage.getItem('knuth-doc')) return;
    sessionStorage.setItem('knuth-doc', JSON.stringify({ name: 'growth.py', dirty: false, text }));
  }, DEMO);
  // On loopback the page looks for an engine; this asks for Pyodide.
  await page.goto(`${url}/?python=browser`);
  await page.waitForSelector('#sheet .cell-wrap');
  await page.locator('#run-all').click();
  await cell(page, 2).locator('.cell-figures svg, .cell-figures img').first().waitFor({ timeout: 180_000 });
  // Let the receipts fly up into the pill. Toasts come and go (in the tab
  // there is no folder for values.json yet), so the pictures leave them out.
  await page.waitForTimeout(1500);
  await page.addStyleTag({ content: '#toast { visibility: hidden !important; }' });
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  // No hover tooltip, no focus ring on the last button pressed.
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`${out}/${name}.png`);
  await page.context().browser()!.close();
}

mkdirSync(out, { recursive: true });

// The document: a text cell, the rate under its cell, the figure.
{
  const page = await open(1000, 830);
  await shot(page, 'document');
}

// The Session card from the pill: what the session holds, cell by cell.
{
  const page = await open(1200, 760);
  await page.locator('#session-pill').click();
  await page.locator('#session').waitFor();
  await page.waitForTimeout(800);
  await shot(page, 'session');
}

// The same document as the plain file on disk (⌘⇧E).
{
  const page = await open(1000, 480);
  await cell(page, 1).locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Shift+KeyE');
  await page.waitForTimeout(1200);
  await shot(page, 'plain-file');
}
