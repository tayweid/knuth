// Render an icon SVG to the PNGs the manifest, the favicon fallback and the
// Mac app icon use: the rounded square on a transparent margin (416 of 512,
// so it sits on the macOS icon grid), 192 and 512 px. The same pipeline as
// Plass's scripts/render-icons.mjs, so the suite's icons render as one hand.
//
//   node scripts/render-icons.mjs                       # public/icons/knuth.svg → knuth-tiles-*.png
//   node scripts/render-icons.mjs <icon.svg> <out-prefix>
import { chromium } from 'playwright';
import fs from 'node:fs';

const [svgPath = 'public/icons/knuth.svg', prefix = 'public/icons/knuth-tiles'] = process.argv.slice(2);
const svg = fs.readFileSync(svgPath, 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [192, 512]) {
  const square = Math.round((size * 416) / 512);
  const margin = Math.round((size - square) / 2);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">
    <div style="position:absolute;left:${margin}px;top:${margin}px;width:${square}px;height:${square}px">
      ${svg.replace('width="64" height="64"', `width="${square}" height="${square}"`)}
    </div></body></html>`);
  await page.screenshot({ path: `${prefix}-${size}.png`, omitBackground: true });
  console.log(`wrote ${prefix}-${size}.png`);
}
await browser.close();
