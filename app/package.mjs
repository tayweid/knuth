// Build Knuth.app on the Claerbout shell (APP.md, "Electron, one shell for
// Claerbout") with @electron/packager, and install it or zip it.
//
//   node app/package.mjs                      # your own copy, into /Applications
//   node app/package.mjs --install ~/K.app    # anywhere else
//   node app/package.mjs --zip out/ --arch arm64,x64
//                                             # the deploy: download zips
//   node app/package.mjs --web dist ...       # the page from a site build,
//                                             # not the staged one
//
// The app leaves Electron's framework out (286 of its 288 MB), so a zip is
// a few megabytes, one per processor. Whoever gets it completes it with
// app/shell/complete.sh, which clones the framework from an installed
// Claerbout app on the same Electron version or downloads Electron's
// release: the install line before moving it into place, or the app itself
// on its first launch (app/shell/launcher.swift), when it came from the
// page's download button. Needs swiftc (Apple's command-line tools). An installed copy from here is complete.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const require = createRequire(import.meta.url);
const config = JSON.parse(readFileSync(path.join(here, 'knuth.json'), 'utf8'));
const electronVersion = require('electron/package.json').version;
const version = process.env.APP_VERSION || JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version;

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  return value && !value.startsWith('--') ? value : true;
}

const web = path.resolve(repo, option('web', 'python/knuth/web'));
const archs = String(option('arch', process.arch)).split(',');
const zipTo = option('zip', null);
let installTo = option('install', null);
if (!zipTo && !installTo) installTo = true;
if (installTo === true) {
  installTo = existsSync('/Applications') && isWritable('/Applications')
    ? `/Applications/${config.name}.app`
    : path.join(os.homedir(), 'Applications', `${config.name}.app`);
}
if (installTo && !installTo.endsWith('.app')) {
  console.error(`package.mjs: the install target must end in .app (got ${installTo})`);
  process.exit(1);
}
if (installTo && archs.length !== 1) {
  console.error('package.mjs: install one architecture at a time');
  process.exit(1);
}
if (!existsSync(path.join(web, 'index.html'))) {
  console.error(`no page at ${web} — run: npm run build:engine`);
  process.exit(1);
}

function isWritable(dir) {
  try {
    execFileSync('test', ['-w', dir]);
    return true;
  } catch {
    return false;
  }
}

const build = path.join(here, 'build');
const stage = path.join(build, 'stage');
rmSync(stage, { recursive: true, force: true });

// The shell, with Knuth's config beside it as app.json.
const appDir = path.join(stage, 'app');
mkdirSync(appDir, { recursive: true });
for (const file of ['main.js', 'preload.js']) cpSync(path.join(here, 'shell', file), path.join(appDir, file));
cpSync(path.join(here, 'knuth.json'), path.join(appDir, 'app.json'));
writeFileSync(
  path.join(appDir, 'package.json'),
  JSON.stringify({ name: config.package, productName: config.name, version, main: 'main.js' }, null, 2),
);

// The knuth package rides in the bundle: the engine's code and, inside it,
// the page. No Python does — the first launch installs one (uv) or runs
// cells in the window (Pyodide).
const python = path.join(stage, 'python');
// The page comes from `web` (the staged page or a site build), so the
// package's own web/ folder is left out here; web.py, beside it, is not.
const packageWeb = path.join(repo, 'python', config.package, 'web');
cpSync(path.join(repo, 'python', config.package), path.join(python, config.package), {
  recursive: true,
  filter: (source) =>
    !/(__pycache__|\.pyc$)/.test(source) && source !== packageWeb && !source.startsWith(packageWeb + path.sep),
});
// The site's installer and app download are not part of the page.
cpSync(web, path.join(python, config.package, 'web'), {
  recursive: true,
  filter: (source) => !['install', 'app'].includes(path.relative(web, source).split(path.sep)[0]),
});

// The app icon, from the same PNG the page uses for its own icon.
const iconSource = path.resolve(here, config.icon);
const iconset = path.join(stage, 'AppIcon.iconset');
mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  execFileSync('sips', ['-z', `${size}`, `${size}`, iconSource, '--out', path.join(iconset, `icon_${size}x${size}.png`)]);
  if (size * 2 <= 512) {
    execFileSync('sips', ['-z', `${size * 2}`, `${size * 2}`, iconSource, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
}
cpSync(iconSource, path.join(iconset, 'icon_512x512@2x.png'));
const icon = path.join(stage, 'AppIcon.icns');
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icon]);

// APP.md: an alternate handler, never the default. The user promotes the
// app in Get Info if they want; installing must not take .py from their
// editor.
const documentTypes = config.documentTypes.map((type) => ({
  CFBundleTypeName: type.name,
  CFBundleTypeRole: type.role,
  LSHandlerRank: type.rank,
  ...(type.contentTypes ? { LSItemContentTypes: type.contentTypes } : { CFBundleTypeExtensions: type.extensions }),
}));

// The command-line tools can ship an SDK newer than their own compiler,
// which swiftc refuses: take the newest SDK it accepts (as app/build.sh
// did), else the default one (Xcode's, on the deploy's Mac).
let chosenSDK = null;
function sdk() {
  if (chosenSDK) return chosenSDK;
  const tools = '/Library/Developer/CommandLineTools/SDKs';
  const probe = path.join(build, 'probe.swift');
  writeFileSync(probe, 'import Foundation\n');
  const candidates = existsSync(tools)
    ? readdirSync(tools)
        .filter((entry) => /^MacOSX\d+\.\d+\.sdk$/.test(entry))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((entry) => path.join(tools, entry))
    : [];
  for (const candidate of candidates) {
    try {
      execFileSync('swiftc', ['-sdk', candidate, '-swift-version', '5', '-typecheck', probe], { stdio: 'ignore' });
      chosenSDK = candidate;
      break;
    } catch {
      // Too new for this compiler.
    }
  }
  chosenSDK ??= execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
  return chosenSDK;
}

const frameworkName = 'Electron Framework.framework';
for (const arch of archs) {
  const [bundleDir] = await packager({
    dir: appDir,
    out: path.join(build, 'out'),
    overwrite: true,
    platform: 'darwin',
    arch,
    electronVersion,
    name: config.name,
    appBundleId: config.id,
    appVersion: version,
    buildVersion: version,
    appCopyright: config.copyright,
    icon,
    // No asar: packager writes an asar's integrity digest into Electron's
    // framework binary (Electron 41+) and re-signs it, and a framework
    // changed per app cannot be cloned from a sibling. The same goes for
    // fuses, which are also bits in that binary: none are flipped.
    asar: false,
    extraResource: [python],
    extendInfo: {
      CFBundleDocumentTypes: documentTypes,
      // What the install line reads to find a sibling to clone from.
      ClaerboutElectronVersion: electronVersion,
    },
    quiet: true,
  });
  const bundle = path.join(bundleDir, `${config.name}.app`);
  // The framework's exact bytes, which a sibling's must match to be cloned
  // and Electron's release must match when downloaded.
  const frameworkBinary = path.join(bundle, 'Contents', 'Frameworks', frameworkName, 'Versions', 'A', 'Electron Framework');
  const frameworkHash = createHash('sha256').update(readFileSync(frameworkBinary)).digest('hex');
  execFileSync('/usr/libexec/PlistBuddy', [
    '-c',
    `Add :ClaerboutFrameworkSHA256 string ${frameworkHash}`,
    path.join(bundle, 'Contents', 'Info.plist'),
  ]);
  // The app ships without the framework: take it out, and put the
  // launcher in front of Electron's own executable. A launch that finds no
  // framework completes the app first (app/shell/launcher.swift).
  const contents = path.join(bundle, 'Contents');
  const frameworkDir = path.join(contents, 'Frameworks', frameworkName);
  const framework = path.join(build, `framework-${arch}`, frameworkName);
  rmSync(path.dirname(framework), { recursive: true, force: true });
  mkdirSync(path.dirname(framework), { recursive: true });
  renameSync(frameworkDir, framework);
  renameSync(path.join(contents, 'MacOS', config.name), path.join(contents, 'MacOS', `${config.name} Electron`));
  execFileSync('swiftc', [
    '-O',
    '-swift-version', '5',
    '-sdk', sdk(),
    '-target', `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
    '-o', path.join(contents, 'MacOS', config.name),
    path.join(here, 'shell', 'launcher.swift'),
  ]);
  cpSync(path.join(here, 'shell', 'complete.sh'), path.join(contents, 'Resources', 'complete.sh'));
  // Ad-hoc signatures for what the packager renamed (the helper apps) and
  // the outer bundle, as it ships: without the framework, which keeps
  // Electron's own signature wherever it comes from. Only on Apple
  // silicon, which refuses unsigned code: Electron's x64 release ships
  // unsigned, and an Intel Mac runs it so.
  if (arch === 'arm64') {
    const frameworks = path.join(contents, 'Frameworks');
    for (const helper of readdirSync(frameworks).filter((name) => name.endsWith('.app'))) {
      execFileSync('codesign', ['--force', '--sign', '-', path.join(frameworks, helper)]);
    }
    execFileSync('codesign', ['--force', '--sign', '-', bundle]);
    // Not --deep: Electron's own release fails a deep strict check
    // (Squirrel.framework), and that is Electron's to fix, not ours.
    execFileSync('codesign', ['--verify', '--strict', bundle]);
  }
  console.log(`built ${bundle} (Electron ${electronVersion}, ${arch}, without its framework)`);

  if (zipTo) {
    mkdirSync(zipTo, { recursive: true });
    const zip = path.resolve(zipTo, `${config.name}-${arch}.zip`);
    rmSync(zip, { force: true });
    execFileSync('ditto', ['-c', '-k', '--keepParent', bundle, zip]);
    console.log(`zipped ${zip}`);
    // The hosted page's download button: the same app under the name it
    // has always had, for Apple silicon (Intel Macs use the install line).
    if (arch === 'arm64') {
      const download = path.resolve(zipTo, `${config.name}.app.zip`);
      cpSync(zip, download);
      console.log(`zipped ${download} (the page's download)`);
    }
  }

  if (installTo) {
    // Replaced wholesale, through a sibling path so a failed copy never
    // leaves no app at all. The framework goes in as a clone of the one
    // this build set aside, as the install line would put it.
    const incoming = `${installTo}.incoming`;
    rmSync(incoming, { recursive: true, force: true });
    mkdirSync(path.dirname(installTo), { recursive: true });
    execFileSync('ditto', [bundle, incoming]);
    execFileSync('cp', ['-Rc', framework, path.join(incoming, 'Contents', 'Frameworks', frameworkName)]);
    rmSync(installTo, { recursive: true, force: true });
    renameSync(incoming, installTo);
    console.log(`installed ${installTo}`);
  }
}
