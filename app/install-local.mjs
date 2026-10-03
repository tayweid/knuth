// Install the checkout's build as Knuth.app, without GitHub: the deploy's
// app job (.github/workflows/deploy.yml) done on this Mac.
//
//   npm run install:local                      # into /Applications/Knuth.app
//   npm run install:local -- ~/Scratch/K.app   # anywhere else
//
// The same three steps: the page built (dist), packaged with the pinned
// shell's packager for this Mac's processor into a site folder of its own
// under the temp folder (app/Knuth-<arch>.zip and app/latest.json, as the
// site has them), and installed from that folder by the install line
// (public/install), which completes the app with Electron cloned from an
// installed Claerbout app on the same version, else downloaded once, and
// refuses while that Knuth is open. The packager puts dist in the bundle
// as the engine's page, so python/knuth/web is not rebuilt here (that is
// `npm run build:engine`, for the commit). `npm run app` runs the checkout
// without installing anything.
//
// The build id is the checkout's commit, with -dirty when the tree has
// changes not committed. It is what the installed app's Check for
// Updates… compares with the site's latest.json: whenever the two differ
// it offers the site's build, and taking it replaces this one with the
// deployed app.
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
// Seven characters, as the deploy's GITHUB_SHA is cut.
const build = git('rev-parse', 'HEAD').slice(0, 7) + (git('status', '--porcelain') ? '-dirty' : '');
const arch = process.arch;

// Where the install line would put it: Applications, or the home folder's
// when that is not writable.
function writable(dir) {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
const target = path.resolve(
  process.argv[2] ?? (writable('/Applications') ? '/Applications/Knuth.app' : path.join(os.homedir(), 'Applications', 'Knuth.app')),
);
if (!target.endsWith('.app')) fail(`the target must end in .app (got ${target})`);

function fail(message) {
  console.error(`install:local: ${message}`);
  process.exit(1);
}
// The install line's own test, asked first so a build is not wasted.
function open() {
  const plain = target.replace(/^\/private/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return spawnSync('pgrep', ['-f', `^(/private)?${plain}/Contents/MacOS/`]).status === 0;
}
const quit = `Knuth is open at ${target}. Quit it (Knuth menu → Quit Knuth), then run npm run install:local again.`;
if (open()) fail(quit);

function run(command, args, env = {}) {
  console.log(`install:local: ${[command, ...args].join(' ')}`);
  return spawnSync(command, args, { cwd: repo, stdio: 'inherit', env: { ...process.env, ...env } }).status === 0;
}

// The site folder goes when this does, however it ends.
const site = mkdtempSync(path.join(os.tmpdir(), 'knuth-site-'));
process.on('exit', () => rmSync(site, { recursive: true, force: true }));

if (!run('npm', ['run', 'build'])) fail('the page did not build (above).');
const packager = path.join('node_modules', 'claerbout', 'package.mjs');
const zip = path.join(site, 'app');
if (!run(process.execPath, [packager, '--config', 'app/knuth.json', '--web', 'dist', '--arch', arch, '--zip', zip], { CLAERBOUT_BUILD: build })) {
  fail('the app did not package (above).');
}
if (!run('bash', ['public/install'], { KNUTH_SITE: site, KNUTH_APP: target })) {
  fail(open() ? quit : 'the install line did not finish (above).');
}
const stamp = JSON.parse(readFileSync(path.join(target, 'Contents', 'Resources', 'app', 'package.json'), 'utf8'));
console.log(`install:local: Knuth.app build ${stamp.build} (${arch}) at ${target}`);
