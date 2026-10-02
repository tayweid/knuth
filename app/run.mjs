// Run Knuth.app from the checkout: the Claerbout shell on app/knuth.json,
// the page from the engine (uv) or the bundle (Pyodide), as the first
// launch chooses. A document path opens it.
//
//   npm run app                    # a new window
//   npm run app -- ~/analysis.py   # opened on that file
//
// The shell is the checkout beside this one (../claerbout, or
// CLAERBOUT_SHELL) when there is one, so a shell feature lands here the
// day it is written; otherwise the package the deploy pins
// (node_modules/claerbout). The run keeps its own state folder and port,
// apart from the installed Knuth.app: the shell's single-instance lock is
// keyed by the state folder, so a checkout launched into the installed
// app's folder would hand its documents to the installed app and quit.
// KNUTH_CONFIG_DIR and KNUTH_PORT override.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sibling = path.resolve(process.env.CLAERBOUT_SHELL ?? path.join(repo, '..', 'claerbout'));
const shell = existsSync(path.join(sibling, 'main.js')) ? sibling : path.join(repo, 'node_modules', 'claerbout');
const electron = createRequire(path.join(shell, 'package.json'))('electron');
const files = process.argv.slice(2).map((file) => path.resolve(file));
const devState = path.join(os.homedir(), 'Library', 'Application Support', 'Knuth (checkout)');
console.log(`knuth: the shell at ${shell}`);
const child = spawn(electron, [shell, ...files], {
  stdio: 'inherit',
  env: { KNUTH_CONFIG_DIR: devState, KNUTH_PORT: '5177', ...process.env, CLAERBOUT_APP: path.join(repo, 'app', 'knuth.json') },
});
child.on('exit', (code) => process.exit(code ?? 0));
