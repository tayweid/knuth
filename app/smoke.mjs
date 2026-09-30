// A smoke test of the Claerbout shell around Knuth: launch it on a document
// in a throwaway config folder, run all, and check the folder contract
// landed beside the document; then check that quitting stops the engine.
//
//   node app/smoke.mjs browser              # the checkout, Pyodide
//   node app/smoke.mjs uv                   # the checkout, uv's Python
//   node app/smoke.mjs uv path/to/Knuth.app # a built app
//
// The uv run installs Python into the throwaway folder (and uv itself into
// ~/.local/bin if the machine has none), as a first launch would.

import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2];
const bundle = process.argv[3];
if (mode !== 'browser' && mode !== 'uv') {
  console.error('usage: node app/smoke.mjs browser|uv [Knuth.app]');
  process.exit(2);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), `knuth-smoke-${mode}-`));
const doc = path.join(work, 'docs', 'smoke.py');
fs.mkdirSync(path.dirname(doc));
fs.writeFileSync(doc, '# %%\nanswer = 41 + 1\n');
const port = String(5400 + Math.floor(Math.random() * 400));

const app = await electron.launch({
  ...(bundle ? { executablePath: path.join(bundle, 'Contents', 'MacOS', 'Knuth'), args: [doc] } : { args: ['app/shell', doc] }),
  env: {
    ...process.env,
    ...(bundle ? {} : { CLAERBOUT_APP: 'app/knuth.json' }),
    KNUTH_CONFIG_DIR: path.join(work, 'config'),
    KNUTH_CHOOSE: mode,
    KNUTH_PORT: port,
  },
  timeout: 60_000,
});
const fail = async (message) => {
  console.error(`smoke (${mode}): ${message}`);
  await app.close().catch(() => {});
  process.exit(1);
};

// The setup window turns into the document's once the Python is ready.
const deadline = Date.now() + 600_000;
let page = null;
while (!page && Date.now() < deadline) {
  page = app.windows().find((window) => !window.url().includes('setup.html') && window.url() !== 'about:blank') ?? null;
  if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!page) await fail(`no document window (${app.windows().map((window) => window.url())})`);
const label = mode === 'uv' ? 'uv' : 'Pyodide';
await page
  .waitForFunction((want) => document.getElementById('kernel-status')?.textContent === want, label, {
    timeout: Math.max(1000, deadline - Date.now()),
  })
  .catch(() => fail(`Python never became ready (${label})`));
if ((await page.title()) !== 'smoke.py') await fail(`the document did not open (title: ${await page.title()})`);
await page.click('#run-all');
const values = path.join(path.dirname(doc), 'values.json');
for (let i = 0; i < 120 && !fs.existsSync(values); i++) await page.waitForTimeout(500);
if (!fs.existsSync(values)) await fail('run all wrote no values.json');
const written = JSON.parse(fs.readFileSync(values, 'utf8'));
if (written.answer !== 42) await fail(`values.json holds ${JSON.stringify(written)}`);

await app.close();
if (mode === 'uv') {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  let engines = '';
  try {
    engines = execFileSync('pgrep', ['-f', `knuth serve --port ${port}`], { encoding: 'utf8' });
  } catch {
    // pgrep exits 1 when nothing matches: the engine is gone.
  }
  if (engines.trim()) {
    console.error(`smoke (${mode}): the engine outlived the app`);
    process.exit(1);
  }
}
fs.rmSync(work, { recursive: true, force: true });
console.log(`smoke (${mode}${bundle ? `, ${path.basename(bundle)}` : ''}): ok`);
