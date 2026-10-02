# Claerbout Autosave: Spec

## Goal
Every project in Plass and Knuth keeps a full, unpruned git record of every edit, from start to finish. Think of it as a GPX track for research. The aim is reproducible science and research integrity. It can't stop a determined cheater, but it changes the question from "can you prove guilt?" to "can you show a clean path from start to finish?"

## Decided

### Commit triggers
- Commit on every cell run, if anything changed.
- Commit every 1 minute, if anything changed.
- Never squash or prune autosave history.

### Branch
- Use one autosave branch per repo, not one per app.
- Write it with git plumbing (a temp index plus `commit-tree`), so the user's working branch and staging area are never touched.
- Tag each commit message with its source app and trigger, e.g. `knuth: cell run [4]`, `plass: timer`, `external edit`, `session open`.
- Skip the autosave if a merge or rebase is in progress, or if `index.lock` exists.

### untracked/ directory
- The app creates `untracked/` automatically and adds it to `.gitignore`. It holds large data, caches, and scratch files.
- Keep a tracked manifest (e.g. `.claerbout/untracked.json`) with each file's path, size, modified time, and SHA-256. Rewrite it before every autosave.
- Only rehash a file when its size or modified time has changed.
- untracked/ must not become a loophole: the manifest keeps it inside the track.

### Secrets
- Auto-ignore common secret files (`.env`, key files).
- Optionally, scan for API keys before each commit. History is permanent and gets pushed, so a leaked secret can't be removed later.

### Environment
- Knuth builds with uv by default and puts pinned versions in a header. Environment changes land in the track.

### Pushing (the outside witness for timestamps)
- Push the autosave branch after every ~10 commits.
- Also push at least every 30 minutes if anything is unpushed.
- Also push on app close.
- If offline, retry quietly while the app is open.
- On launch, push anything still unpushed first.

## Planned / open

### Outside edits and gaps
- The app remembers the hash of each file as *it* last wrote it. If the file on disk doesn't match, the commit is tagged `external edit`.
- Log session open and close as commits.
- On launch, if files changed while the app was closed, record a "changed while closed" commit.
- Git is already a hash chain. The remote push is what pins the time.
- Optional later: OpenTimestamps for an independent timestamp.

### Preregistration
- The first commit of a project is the analysis plan. Its pushed timestamp shows what was intended before any results existed.

### Anti-pruning remote (the p-hacking problem)
- Deleting commits or branches locally is easy. The fix is a remote the user can push to but can't alter.
- Idea: a shared Claerbout GitHub org. The org owns the repos, and users get write access only. The autosave branch is protected (no force-push, no deletion), and only org owners can delete repos.
- Repos stay private while work is in progress, reviewers get read access during review, and repos go public on publication.
- Only hashes of untracked/ data are pushed, so confidential data stays local.
- Users must then trust the org owner. Mitigation: archive public repos automatically to Software Heritage.
- Known limits: running many parallel projects with different plans, and long offline stretches. Both can be made visible (all starts live on the shared remote, and long unwitnessed stretches get flagged) but not prevented.

### Future project
- A replay viewer with a timeline scrubber for walking the track. Gaps and external edits should show clearly.

## Implementation note
Build this as one shared module in the Claerbout package. Plass and Knuth both call it.

## Built (2026-10-02)

The module is the shell's `autosave.js` (claerbout, required by `main.js`,
documented in its README under "The autosave record"), and Knuth and Plass
both run on it: the shell is the git runner, since it has the filesystem
and knows each window's document, and the pages only say when something
happened. `"autosave": true` in an app's config turns it on; Knuth's
`app/knuth.json` and Plass's `app/plass.json` set it, ManimLive's does not.
`<PREFIX>_AUTOSAVE=0` turns it off for a test and `<PREFIX>_AUTOSAVE_INTERVAL`
(seconds) shortens the timer.

What landed, of the Decided section:

- **The project.** The repository the document's folder is in, wherever
  that is. A folder in none gets one (with `untracked/` ignored), but only
  in a project's folder: never the home folder or a folder it is in,
  never `~/Desktop`, `Documents`, `Downloads`, `Movies`, `Music`,
  `Pictures`, `Public` or `Library` themselves, a cloud-synced root (iCloud
  Drive and the apps' containers, `~/Library/CloudStorage/*`, a Google
  Drive's `My Drive`, `~/Dropbox`, `~/OneDrive…`, `~/Box`), a temporary
  folder or a volume root; a folder at least one level below those
  (`~/Projects/foo`, `~/Desktop/week-3`) qualifies. Elsewhere: no record,
  and one log line saying why, once per folder per launch. (Decided after
  the first review: a document in `~` had initialised `~/.git` and hashed
  the whole home folder every minute.) No record at all, repository or
  not, in a hidden folder of the home folder (`~/.ssh`, `~/.aws`,
  `~/.config/gh`) or a folder named `.ssh`, `.aws`, `.gnupg` or `.env`, nor
  for a repository whose root is the home folder or a folder it is in,
  said once (decided after the second review: `~/.aws/config` had put the
  AWS keys into a new `~/.aws/.git`, and a dotfiles `~/.git` took in
  `.zsh_history`).
- **The branch.** One per working tree, a refinement of "one autosave
  branch per repo": `refs/heads/claerbout-autosave` in a repository's main
  working tree, `refs/heads/claerbout-autosave-<name>` in a linked
  worktree (`<name>` as git keeps it in `.git/worktrees`; a hyphen, since
  git cannot keep `claerbout-autosave/<name>` beside
  `claerbout-autosave`), so two worktrees open at once never flap the tip
  between their trees. Two apps on one working tree share its branch (the
  update is a compare-and-swap, retried once). Written with plumbing
  only: a temporary index, kept between commits in the app's state folder
  for its stat cache and removed at quit, filled by `git add -A
  --ignore-errors` (so `.gitignore` applies), entries the ignore rules or
  the secrets have come to match since dropped from it, then
  `write-tree`, `commit-tree` on the tip, `update-ref --no-deref`. Every
  git runs with `core.splitIndex`, `core.fsmonitor` and the add advice
  off, so nothing lands in the user's `.git` but objects and the branch.
  It also runs with `core.sparseCheckout` off, so a sparse checkout is
  recorded (git add had refused the manifest outside the cone every
  tick), without lazy fetches, and with `/opt/homebrew/bin`,
  `/usr/local/bin` and `/etc/paths` after the app's own `PATH`, so git-lfs
  is found from a Finder launch; a required filter that still cannot run
  skips the commit with one log line, and any other failure is said once
  until a commit lands again.
- **What it never touches, and what it writes.** The user's HEAD, branch
  and index are never touched: nothing is committed while the record's
  branch is checked out in any working tree (an `update-ref` would move
  that HEAD, which the first review showed), while `index.lock` exists or
  a merge, rebase, cherry-pick or revert is in progress, or when the tree
  equals the tip's. The second review added: nothing while the branch is
  being rebased in any working tree or is a symbolic ref, and every guard
  is asked again just before the ref moves, since a fill takes seconds. In
  the working tree it writes `untracked/`, a `.gitignore` line and
  `.claerbout/untracked.json`, which show in the user's `git status`, and
  never through a symbolic link: a link at any of those names turns the
  manifest off for that project, said once. A file git cannot read is left out (named once in
  the log) and the rest recorded; a nested repository without a commit is
  left out until it has one, then recorded as a gitlink. Messages are
  `<app>: <trigger>`; the author is the repository's identity, else
  `Claerbout Autosave <autosave@claerbout.local>`.
- **The triggers.** Knuth sends `{type: 'autosave', trigger: 'cell run
  [n]'}` when a cell's run completes (`DocumentView.onRunDone` →
  `reportCellRun` in `shell.ts`), once the run's writes have landed: the
  document's autosave (1.2 s) and the project contract (`values.json`,
  `figs/`; 300 ms), so the commit holds what the run produced — a notice
  sent at completion found the tree unchanged and the timer took the
  change a minute later, which the first smoke run showed. Runs that
  complete while those writes settle (a run-all) are reported together,
  `cell run [1, 2, 3]`. The timer is one minute per open project, not per
  window, and a tick while a commit is under way is dropped, never
  queued; `session open` and `session close` bracket the first and last
  window on a project; one job at a time per project. Quitting closes
  every session and waits for every queued job, bounded at 20 s. Each
  commits only if something changed.
- **untracked/.** Created in the project with a `.gitignore` entry; the
  manifest `.claerbout/untracked.json` (path, size, mtime, SHA-256 per
  file, hashed again only when size or mtime changed, the hashes cached
  in the app's state folder) is rewritten before every commit and always
  recorded, as is `.gitignore`, whatever the ignore rules say (a `*.json`
  or `.claerbout/` line had kept it out). A file named `untracked` means no
  `untracked/` handling for that project, said once. A file in
  `untracked/` that the secrets list matches is left out of the manifest,
  name and hash, and only counted in the log.
- **Secrets.** Kept out by pathspec, in every folder and whatever the
  case: `.env`, `.env.*`, `*.pem`, `*.key`, `id_*`, `*.p8`, `*.p12`,
  `*.pfx`, `*.jks`, `*.keystore`, `*.keychain`, `*.keychain-db`, `*.gpg`,
  `*.asc`, `*.ppk`, `*.kdbx`, `credentials.json`, `service-account*.json`,
  `client_secret*.json`, `kaggle.json`, `secrets.toml`,
  `.git-credentials`, `.pypirc`, `.npmrc`, `.netrc`, `.htpasswd`,
  `.Renviron`, `token`, `token.txt`, `*.token`, `.token*`, and everything
  under `.env/`, `.aws/`, `.ssh/` and `.gnupg/`. `tokenizer.py` and
  `tokens.json` are recorded; `id_*` catches `id_map.csv` and `*.key` a
  Keynote deck, so the log names what the list kept out of a project once
  per launch, and such a catch is seen.
- **Plass.** Its documents are handles, not paths, so the page sends
  `{type: 'document', path, name, size, modified}` whenever its open file
  changes (`reportDocument` in `src/claerbout.ts`, from the file
  manager's handle setter), and the shell's window → document map is
  right for Plass too, the window's represented file with it. The preload
  gained `pathOf(file)` (Electron's `webUtils.getPathForFile`) for the
  path, but a File from a handle's `getFile()` is blob-backed and has
  none (measured tonight; a dropped File has one), so the path comes from
  the other side: Chromium asks the shell's permission handler about
  every read and write of a handle, with the file's path but no window,
  and the shell matches the reported name, size and mtime against the
  files lately touched, newest first; a report that matches none of them
  is none (no same-name fallback). A reported `path` is taken only when it
  is an absolute path to an existing regular file.
- **Tests.** The shell's `test/autosave.test.mjs` (node:test, real git in
  temporary repositories: a folder with no repository, a clean branch
  with a dirty index left as they were, `index.lock`, a merge in
  progress, the unchanged skip, the record checked out in the main and a
  linked worktree, the project-folder rule, linked worktrees, an
  unreadable file, a nested repository without a commit, the secrets and
  the README's list of them, the manifest forced in and its cache, the
  kept index, nothing new in `.git` under `core.splitIndex`, a file named
  `untracked`, the identity, the sessions, the timer not piling up, quit
  waiting and bounded; and from the second review the guards asked again
  before the ref moves, a rebase in a linked worktree, a symbolic ref,
  hidden home folders, a repository at home, links, secrets in any case
  and in `untracked/`, a sparse clone, git's `PATH`, a missing filter and
  a failure said once); its fixture smoke checks
  the `session open` commit; Knuth's `src/shell.test.ts` pins the notice;
  Plass's `src/claerbout.test.ts` pins the document report; Knuth's smoke
  (`smoke.autosave` in `app/knuth.json`) asserts `knuth: session open` and
  `knuth: cell run [1]` on the document's folder, Plass's `app/smoke.mjs`
  asserts `plass: session open` and the represented file. Every test
  works in a temporary folder.

What stays open, and why:

- **Pushing (the outside witness).** Not built. The module never pushes;
  the record stays on the machine. The push policy is decided above (every
  ~10 commits, every 30 minutes with anything unpushed, on close, on
  launch; never forced; failures retried quietly), and after the review it
  was to be built as: only `refs/heads/<record>` to a remote named
  `origin`, never `--force`, a failure one log line retried at the next
  trigger, `<PREFIX>_AUTOSAVE_PUSH=0` set in every test and smoke, and a
  test against a bare temporary remote. Writing it was refused twice by
  the permission check (automatic pushes from inside the app, against the
  standing no-push rule), so it is Taylor's to build or to authorise;
  nothing else in the module would change. The anti-pruning remote (the
  Claerbout org) is the other half of that decision.
- **External-edit tagging** and the "changed while closed" commit on
  launch: the module keeps no per-file hashes of what the app itself
  wrote, so a change made outside the app is recorded by the next
  trigger as that trigger's commit, untagged.
- **Preregistration:** the first commit is whatever the folder holds when
  the first window opens, not an analysis plan.
- **Key scanning:** only file names are excluded; a key pasted into a
  notebook is recorded, and the record is permanent.
- **The replay viewer.**
- Smaller: a run in the browser tab (no shell) is not recorded; a nested
  repository inside the project is recorded as a gitlink, not its
  contents; the manifest and the `.gitignore` line show in the user's own
  `git status` as untracked and modified, which the spec accepts; a file
  the user tracks although an ignore rule matches it (`git add -f`) is
  left out of the record, since the temporary index starts from the
  working tree, not from HEAD.
