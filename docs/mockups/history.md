# The history view: 2026-10-02

Taylor this morning: "id love to get autotracking done. and then maybe even
have a git history rewind visualizer, with the commits in a path, with
branches visualized, and the ability to rewind by clicking on a node in the
window."

The autotracking is built: the shell's `autosave.js` commits a project's
working tree to the branch `claerbout-autosave` on every cell run and every
minute something changed (`docs/AUTOSAVE.md`, "Built"). This is the record
of the view that walks it. It lives in the shell, so Knuth and Plass share
one: a window the shell opens and serves itself, in the Zen frame the apps
now use (#18181a, a 48px rail of 32px tiles, the room rounded 12px inside one
8px edge, the values in Plass's `src/style.css`). The page asks the shell for
the graph and for a rewind.

Three designers drew it, each from a different angle, and two judges scored
them: one for research use (can you find the moment before a mistake, and
does the window say what a rewind will do), one for whether it can be built
on today's shell. This file is the design record and the spec to build from.
The recommended composite, with the grafts applied, is
`history-recommended.html`.

## Recommendation

Build the river (`history-river.html`). Both judges put it first, at 8 each,
and ranked the other two the same way (ledger tree, then timeline).

The record runs down the room as a river. Time flows down, the oldest at the
top, and the window opens at the mouth, which is now. That is the direction
Knuth's column of cells and Plass's pages already read, and a rewind lands
where the eye already is. A cell run is a bold dot with its message, a timer
commit is a faint bead, earlier days fold to one reach each, and your own
branches are tributaries beside the river with square nodes and your words
in serif. Click a node and a card opens beside it, tied by a hairline the way
the session-panes cards sit beside their cells. It says what that commit
changed, then what a rewind would change against now, file by file, with a
checkbox to leave a file out.

Why it won:

- **It draws a rewind as what it is.** Two nodes land at the tip: a ring for
  "rewind from" (the files as they were at the click) and a blue node for
  "rewind to", with a dashed arc back up to the moment it reproduces.
  Nothing above moves. Undo is one more rewind, and its arc nests in a second
  lane; the researcher pressed it in a headless run and it still read
  cleanly.
- **The card decides the rewind.** It lists each file and what goes back,
  and warns in amber about the realistic trap: the Plass paper shares the
  folder, so "about 470 words written since 10:14 leave the page; they stay
  in the record". It says untracked/ is never rewound and that Python's
  memory is not, so the cells come back stale.
- **It is the most faithful to the record.** It is the only design that
  noticed the record's first commit is a root (`commit-tree` adds `-p` only
  when a tip exists), so it never invents ancestry between the record and
  main, and that session open and close commit only when the tree changed.
- **It is the cheapest to build on one code path.** The page shows diffs and
  white-print thumbnails; it never renders a whole Knuth document or a Typst
  page. The other two need Knuth's renderer, and the timeline Plass's Typst
  compiler too, inside a shell page.

The grafts, from both judges, most important first:

1. **The rows say what they touched.** A fold of timer commits reads
   "4 timer commits · cells 16, 17" or "· paper.typ" instead of a count
   (ledger). A bead names its cell or file. The labels of the beads near the
   selected node stay visible. A run that raised is a red ring (timeline);
   Knuth's notice says so in the message (open question 2). This closes most
   of the river's gap at finding the moment before a mistake.
2. **The cell strip, twice** (ledger). One box per cell of the document.
   Under "This commit" the changed cells are lit. Under "Rewinding here" the
   boxes say comes out, goes back, comes back, or the same.
3. **Open in Runs, not Every commit.** ⌥↑ and ⌥↓ jump between runs, skipping
   beads (timeline). ↑ and ↓ still walk every node, and the card follows.
4. **Click again to rewind** (timeline, by way of the buildable judge).
   Clicking the selected node a second time does what the card's button
   does; hovering it says so. A double-click counts as one click, so a stray
   double-click selects and never rewinds. This is Taylor's "rewind by
   clicking on a node", with the card open first.
5. **A compare-and-swap on the rewind** (ledger). The page sends the tip it
   drew; the shell refuses with `moved` if the record moved meanwhile, since
   a one-minute timer can commit between the preview and the click.
6. **The paused state** (ledger). A pill in the top bar names the guard ("a
   rebase is in progress on main"), and the card's button waits and says
   why.
7. **The other app, named** (timeline). The card names a file open in
   Plass. If Plass opened it after the card was drawn, the shell refuses with
   `other-app`, and the card offers "Without paper.typ" or "Rewind anyway".
8. **The protocol's shape** (timeline): one `history` request with an
   `action`, plus `rewind`, the way `update` and `update {action:'install'}`
   sit in `main.js`'s `answer()`. The river's step events stay. The empty
   states follow the record's real reasons, and the record's first commit
   lands at session open, not at the next cell run (ledger).
9. **Rewind rows as the record writes them:** "knuth: rewind to 5f8b30a".

Not grafted: the timeline's and the ledger's whole-document rendering (a
second Knuth renderer and a Typst renderer in the shell), and the ledger's
undo-tree lanes, which re-lay the rows after every rewind and read like a
reset. Dropped from the river: the dotted mouth that named the files changed
since the last commit. No page can know that: a timer fill that finds a
change commits at once, so right after a tick it is always empty.

## The three mockups

| Mockup | File | In one line |
| --- | --- | --- |
| The river | `history-river.html` | Time flows down the room; the record is the stream, your branches tributaries tied where they hold the same files; a card beside the selected node says what changed and what a rewind would change; Rewind is the card's button. |
| The timeline | `history-timeline.html` | A video scrubber in a band along the window's bottom edge; the room above shows the whole document as it was under the playhead; branches as lanes; click to hold, click again to rewind. |
| The ledger tree | `history-ledger-tree.html` | `git log --graph` typeset in a column on the frame, one row per commit; the room shows the selected step's diff of the document; rewind from the row's menu; lanes re-laid as an undo tree after a rewind. |
| Recommended | `history-recommended.html` | The river with the grafts above. |

Every mockup is self-contained: double-click to open. Each has a states card
in a corner (mockup chrome, not the shell).

## The judges

Scores out of 10, rank in brackets.

| | Research use | Buildable | Total |
| --- | --- | --- | --- |
| The river | 8 (1st) | 8 (1st) | 16 |
| The ledger tree | 7.5 (2nd) | 6.5 (2nd) | 14 |
| The timeline | 6.5 (3rd) | 6 (3rd) | 12.5 |

The judges agreed on the whole order. Where they differed, it was about
emphasis:

- **The river's weak spot.** The research judge found it the weakest of the
  three for finding the moment before a mistake: rows repeated "knuth: cell
  run [9]" four times, beads named what they caught only on hover, errors
  were not marked, and the morning opened in Every commit with long unlabeled
  stretches. Grafts 1 to 3 answer each of these.
- **The ledger tree.** Both judges called its "Against now" the most
  complete rewind preview, and both took its compare-and-swap and its paused
  state. Both refused its rewind in a row menu (furthest from Taylor's ask)
  and its undo-tree lanes (after three rewinds the narrow column stacked
  three rewind rows across shifting lanes).
- **The timeline.** Closest to Taylor's words, and the fastest way to find a
  moment by sight. Both judges marked it down for the same reasons: a
  file-level preview only, the step forward drawn as two 6px glyphs and a
  hairline arc, the graph squeezed into an 80px band, and the heaviest build.
  Its protocol had the best shape, and that shape is taken.
- **Gaps none of the three closed,** found by the buildable judge against
  `autosave.js` and a scratch repository, are in the rules below: the rewind
  as one job on the project's queue, "rewind to" committed even when its tree
  equals the tip, the write set from `diff-tree` rather than
  `checkout-index -a`, and a commit on main that never removes what its tree
  lacks.

## The shell protocol

Everything goes through the existing preload: `window.claerbout.request
(message) → Promise` and `window.claerbout.on(event, listener)`. Nothing new
crosses the bridge. An older shell answers `null` to every request below,
which is how a page knows to hide its History button.

### From a document page (Knuth, Plass)

- **`{type: 'history', action: 'open', at?: sha}`.** Open the History window
  for this window's project, or bring it forward if it is open, with `at`
  selected. Answer: `{opened: true}`. A window with no project (an Untitled
  document, a folder the record refuses) still gets a History window, which
  says why there is no record.

### From the History page

The shell answers these only from a History window, through its own
`answerHistory`, and always for that window's project: the page never names
a folder. A document page cannot ask for a graph, and the History page
cannot read or write files.

**`{type: 'history', action: 'graph', before?: sha, limit?: 2000}`**, the
graph. Answer:

- `state`: `'on'`, `'paused'` or `'none'`.
- `reason`: for paused, the guard in words ("a rebase is in progress on
  main", "index.lock exists", "claerbout-autosave is checked out"). For
  none, one of `'unsaved'` (no document path), `'refused'` (not a project's
  folder, or where credentials are kept), `'off'` (the config or
  `<PREFIX>_AUTOSAVE=0`), `'no-git'`; with `detail`, the folder and the rule,
  for the empty window.
- `project`: `{root, name, branch}`, where branch is `claerbout-autosave` or
  `claerbout-autosave-<worktree>`.
- `app`: this shell's app (`'knuth'`), the one whose windows it can save and
  reload.
- `tip`: the record's tip, or null before its first commit.
- `head`: `{branch: 'main' | null, sha}`, the user's HEAD, for a "you are on
  main" note.
- `branches`: `[{name, tip, head: bool}]`, the user's local branches.
- `commits`: newest first, the record and the user's branches in one list.
  Each commit is:
  - `sha`, `parents: [sha]`;
  - `line`: `'record'` or the branch name it was reached by; `refs`: the
    branch names whose tip it is;
  - `time`: the author time, ISO with its offset; `author` for a commit on a
    user branch;
  - `subject`: the message's first line, verbatim;
  - `files` (the number of files changed), `plus`, `minus`, and `changed`
    (the first 20 paths);
  - parsed by the shell from "<app>: <trigger>", so the page never parses
    commit text: `app` (`'knuth'`, `'plass'`), `trigger` (`'run'`,
    `'timer'`, `'open'`, `'close'`, `'rewind-from'`, `'rewind-to'`, or
    `'notice'` for anything else), `cells` for a run, `error` when the run
    raised, `from` and `target` for a rewind, `paths` for a partial one;
  - on a user branch, `tie`: `{sha, exact: true}`, `{sha, exact: false,
    differs: [path]}`, or null.
- `more`: whether older commits exist; `total`: the record's length.

The shell builds the list from one log:

```
git log --date-order --parents --source --numstat -z --format=… \
  --exclude=claerbout-autosave --exclude='claerbout-autosave-*' --branches \
  refs/heads/<this worktree's record> -n <limit>
```

`--branches` with the two excludes takes the user's branches but no record
(neither the main working tree's nor another worktree's); the record comes
in by name. Not `--all`, which pulls in `refs/stash`, remotes and other
worktrees' records. In a scratch repository `%S` labelled each commit's line
(`main`, `refs/heads/claerbout-autosave`) and the record and main came back
as two roots, as they are. Paging goes back in time with `before`, the
oldest sha the page holds: the same log, `--until` that commit's time; the
page drops any it already has. Folding by day, by timer runs and by zoom is
the page's.

A **tie** joins a commit on a user branch to the record. It is the newest
record commit, at or before the user commit's time, that holds every file
the user commit holds, byte for byte: `git diff-tree -r --no-renames
--name-only --diff-filter=DMT <user> <record>` is empty. Files only the
record has (the manifest, a paper never committed on main) do not count,
since user commits are often partial and exact tree equality would rarely
hold. When none matches within 200 record commits, the tie is the one with
the fewest differing paths, with `differs`. The candidates go through one
`git diff-tree --stdin` per user commit, and ties are cached by sha for the
launch.

**`{type: 'history', action: 'commit', sha}`**, what one commit changed.
Answer: `{sha, parents, time, subject, files: [{path, status: 'A' | 'M' |
'D' | 'T', plus, minus, binary, patch?}]}`, from `git diff-tree -r -p
--no-renames` against its first parent (the empty tree for the record's
first commit). A patch is capped at 400 lines per file and 1 MB in all.

**`{type: 'history', action: 'blob', sha, path}`**, a file at a commit or
tree. Answer: `{text}` (UTF-8, at most 1 MB) or `{binary: true, size}`. An
SVG comes back as text and the page shows it through the suite's safe-svg as
an image, so no script in a figure runs.

Cells, values.json names and word counts are the page's, worked out from
blob text: it splits a percent-format file on its `# %%` lines and maps the
patch's hunks to cells, compares two values.json blobs by key, and diffs two
.typ texts for words. It does this for the rows on screen and caches by blob
sha, so a fold reads "· analysis.py" at once and "· cells 16, 17" a moment
later. The shell knows git, not the apps' formats.

**`{type: 'history', action: 'compare', sha, paths?}`**, what a rewind to
this commit would do now. Answer:

- `tip`: the record's tip the answer was computed against;
- `now`: the tree of a fresh fill of the working tree, the same fill a
  commit makes, written but not committed (the page reads now's blobs from
  it);
- `unrecorded`: the paths now differs from the tip in, which the rewind
  records first as "rewind from";
- `write: [{path, status}]`, `remove: [path]`, `skipped: [{path, why}]`: the
  rewind's set, by the rules below;
- `same`: the number of files equal at both moments;
- `untracked`: true when the target's manifest differs from now's, and
  `untrackedGone: [path]`, files the target's manifest lists that untracked/
  no longer holds with that hash, which cannot come back;
- `others: [{app, documents: [path]}]`: another app's windows on this
  project;
- `blocked`: the guard's reason, or null.

It runs on the project's job queue, like a commit.

**`{type: 'rewind', sha, tip, paths?, anyway?}`**, the rewind. It runs as
one job on the project's queue (`Project.run`), so this shell's timer is
dropped while it runs (a tick is dropped while a job is pending). Before the
three steps:

- **Checks.** The record's tip must still be `tip`, else `{refused:
  'moved', tip}`. No guard may hold (the record's own `blocked()`), else
  `{refused: 'paused', reason}`. If another app has windows on the project
  holding a file the rewind writes, and the request did not say `anyway`,
  `{refused: 'other-app', app, documents}`. If nothing would be written or
  removed, `{same: true}`.
- **Save.** The shell sends `flush {id, reason: 'rewind'}` to its own
  document windows on the project and waits for each `{type: 'flushed', id}`,
  at most 3 seconds each. A window that does not answer refuses the rewind:
  `{refused: 'unsaved', path}`.

Then the three steps:

1. **Record now.** A commit "<app>: rewind from <tip>" through the normal
   commit path, skipped when the working tree equals the tip.
2. **Write the target's files.** The write set comes from `git diff-tree -r
   --no-renames --name-status <tip> <target>`, with the tip as it is after
   step 1: `A`, `M` and `T` paths are written, `D` paths removed. (In a
   scratch repository, `diff-tree <tip> <target>` gave `M a.txt` for a
   changed file and `D c.txt` for one the target lacks.) The files are
   written with plumbing only: `GIT_INDEX_FILE=<throwaway> git read-tree
   <target>`, then `git checkout-index -f -- <paths>`, never `-a`, which
   rewrites every file's mtime and trips the apps' change watchers. Removed
   files are unlinked, and their folders removed while empty, never past the
   project's root. The throwaway index is deleted after.
3. **Record the rewind.** A commit "<app>: rewind to <target>", or
   "<app>: rewind to <target> (a.py, b.json)" for a partial rewind ("(3
   files)" past two). It always lands, even when its tree equals the tip's:
   in the scratch repository a second shell's timer recorded the rewound tree
   first, and the normal commit path then skipped "rewind to" as unchanged,
   losing the arc's anchor. So the shell calls `commit-tree` here without the
   unchanged check.

After: the shell sends `reload {id, paths, reason: 'rewind', to}` to its own
document windows on the project, with every written and removed path; each
page re-reads its document if its path is among them, and leaves its
read-only hold either way.

Answer: `{ok: true, from: sha | null, to: sha, target: sha, written: [path],
removed: [path], skipped: [{path, why}]}`, where `from` is the "rewind from"
commit (null when step 1 was skipped) and `to` the "rewind to" commit. If
git fails in step 2 or 3, the answer is `{refused: 'failed', detail}`, and
the next timer tick records whatever the folder then holds, so even a broken
rewind leaves a true record.

On `moved`, the page asks `compare` again. If the write and remove sets are
the same, it sends the rewind again by itself, once; otherwise it redraws
the card with a line saying the record moved on.

### Events

To the History page:

- `history {kind: 'commit', commits}`: the record or a user branch grew;
  each commit is shaped as in the graph. The page appends at the tip.
- `history {kind: 'refs', branches, head}`: a branch moved, appeared or went,
  or HEAD changed.
- `history {kind: 'state', state, reason}`: paused, or recording again.
- `history {kind: 'focus', at}`: a document window asked to open History
  while it was open.
- `rewind {step: 'save' | 'record-from' | 'write' | 'record-to' | 'reload',
  state: 'doing' | 'done', detail?}`: progress, sent the way `runUpdate`
  sends `update`. The card shows the steps from these.

The shell sends `history` events for its own commits as they land (a hook
on `Project.commit`) and finds everyone else's by checking every open
project's record tip and branch refs every 2 seconds. It reads the loose ref
file and falls back to `git rev-parse` when the ref is packed, and runs
`git log <old>..<new>` when the tip moved.

To the document pages:

- `flush {id, reason: 'rewind'}`: write the open document if it has unsaved
  changes, through the page's usual write, answer `{type: 'flushed', id}`,
  and hold edits (read-only) until the matching `reload`, at most 10 seconds.
- `reload {id?, paths, reason: 'rewind', to}`: re-read the document from
  disk if its path is in `paths`.
  - Knuth keeps its session and marks every cell stale (`markAllStale`,
    `src/document-view.ts:645`), since the kernel was not rewound, and its
    session pill says so.
  - Plass reloads the paper.
  - A page with unsaved edits to that file asks before reloading. Only the
    other app's windows can be in that state, since this shell's were
    flushed.

## The rewind rules

- **A rewind is a step forward that reproduces an older state, never a
  reset.** The record only grows: "rewind from" before, "rewind to" after,
  and nothing on it moves or is removed. Undo is one more rewind, to the
  "rewind from" commit.
- **It never touches the user's HEAD, branch or index.** The write goes
  through a throwaway index file, and the record's own branch is the only
  ref that moves. In the scratch repository, HEAD stayed on main at its
  commit and `git diff --cached` stayed empty. Afterwards the user's
  `git status` lists the rewound files as changed against HEAD, as it would
  after any edit; the card says so.
- **It commits before and after,** as above, so the files at the click are
  always recoverable, and every rewind is visible in the record with its
  target named.
- **It saves first and reloads after.** This shell's windows are flushed
  before the record commits, and reloaded after the write. Python's memory
  is not rewound: Knuth's cells come back stale.
- **untracked/ is never touched.** It is ignored, so it is never in a record
  tree, and nothing in it is written or removed. The card says so whenever
  the manifest differs, and names the files the target used that cannot come
  back because the record keeps only their hashes.
- **The manifest is never written by a rewind.** `.claerbout/untracked.json`
  is left out of the write and remove sets. The "rewind to" commit rewrites
  it from untracked/ as it is, like every commit, so the record says
  truthfully what untracked/ held after the rewind.
- **`.gitignore` is rewound like any file, and then the record prepares
  again.** `Project.prepare()` runs once per launch. A target whose
  `.gitignore` lacks `/untracked/` (a commit on main from before the record
  began, say) would otherwise stop ignoring untracked/, and the next fill
  would take the whole folder into the record. So after the write the shell
  clears `prepared`, and the "rewind to" commit adds the line back.
- **It never overwrites what the record has not kept.** An `A` path (in the
  target, not in the tip) that exists on disk can only be an ignored or
  secret file, since step 1's fill took in everything else. It is skipped and
  named. Secrets are never in a record tree, so none are ever written.
- **It never writes through a symbolic link.** `checkout-index` replaces a
  link rather than writing through it; the shell's own removals use `lstat`
  and remove the link itself. Gitlinks (a nested repository) are left alone.
- **A commit on a user branch writes only the files it holds.** A rewind to
  a commit on main writes main's version of each of its files and removes
  nothing it lacks: files only the record has (the paper never committed, the
  figures) stay as they are. main stays where it is.
- **What is refused.** No rewind while a merge, rebase, cherry-pick or
  revert is in progress, while `index.lock` exists, while the record's branch
  is checked out or being rebased in any working tree, or while it is a
  symbolic ref: the record's own guards, asked again just before the "rewind
  to" ref moves. Also refused: a tip that moved since the preview (`moved`),
  a file another app holds that the user was not told about (`other-app`),
  and a window that did not save (`unsaved`).

## Where the page lives

- **The file.** `claerbout/history.html`, one plain HTML file with its
  script and style inline and no build step. It is the first page the shell
  ships itself. `package.json`'s `files` lists it, and `package.mjs:155`
  copies it beside `main.js`.
- **The address.** `<scheme>://app/_claerbout/history.html`
  (`knuth://app/_claerbout/history.html`). `servePage` gets a second root:
  `/_claerbout/` is served from the shell's own folder (`__dirname`) and is
  checked before the app's `webRoot`, so no app's page folder can shadow it
  or be reached through it. The scheme handler is registered in every mode,
  so this works for Knuth's uv mode too, where the document windows are on
  the engine's origin.
- **The window.** `openHistory(root, at)` makes its own BrowserWindow with
  the same preload and frame, its own remembered size (`historySize`, so it
  never overwrites the document windows' size), and the title "History —
  week-3". One per project: a second open focuses it and sends
  `history {kind: 'focus', at}`. It never calls `setDocument` with a path,
  or the record would open a session for it. Its origin is the app's, so
  `trusted()` admits it as is, and the shell routes its requests to
  `answerHistory` by a window → root map.
- **Opening it.**
  - A menu item, **View › History…** (⇧⌘H), for the focused document window.
    ⌘Y is redo in both apps and ⌥⌘H is Hide Others, so neither is free.
  - The page request `{type: 'history', action: 'open'}`, from a rail button
    in Knuth and an item in Plass's File menu, beside each app's update
    control.

## Open questions

A suggested default follows each.

1. **Click again to rewind, or only the card's button.** Default: both. The
   second click works once the card is open, and a double-click counts as
   one click. Undo is one click away in the note that follows.
2. **Error runs in the record.** Today `reportCellRun` (`src/shell.ts:105`)
   sends `cell run [4]` whether or not the run raised, so the record cannot
   mark an error. Default: send `cell run [4] (error)` when any reported cell
   raised, and the shell parses `error`. One line in Knuth, with the outcome
   passed in from `runCell`.
3. **The sha in a rewind's message.** Default: the full 40 characters, since
   the record is permanent and short shas can grow ambiguous over a long
   record. The page shows seven.
4. **A rewind to a commit on main.** Default: write main's files, remove
   nothing main lacks (the rule above). The alternative, rewinding to the
   commit's tie instead, is one click away: the card links the tie.
5. **Two shells.** Knuth.app and Plass.app share one record but cannot
   message each other's pages. Default:
   - each shell writes a presence file for each project it has windows on,
     in a shared folder, `~/Library/Application Support/Claerbout/presence/`:
     `{app, pid, root, documents}`, removed when the last window leaves and
     at quit, and ignored when its pid is gone;
   - `compare` reads them for `others`, and `rewind` refuses `other-app` from
     them;
   - each shell's 2-second check sees a "rewind to" commit made by another
     app and sends `reload` to its own windows on that project.

   The alternative, a channel between the shells, is more machinery for the
   same result.
6. **A fourth zoom, Sittings** (no gap over 30 minutes), between Days and
   Runs. Default: no. The gaps over 12 minutes already break the river into
   sittings, labelled in words.
7. **Seeing a moment's whole document.** Default: later. A link in the card
   asks the open Knuth or Plass window to show `<sha>:<path>` read-only, on
   the app's own renderer, rather than a second renderer in the shell.
8. **External edits and "changed while closed".** AUTOSAVE.md still lists
   both as planned, and the record does not write them. Default: draw nothing
   for them until it does; then an amber mark, as the timeline drew.
9. **The save wait.** Default: 3 seconds per window (the designers proposed
   2, 3 and 5).
10. **The check interval.** Default: 2 seconds for every open project. It is
    one small file read, and it is what makes the other app reload promptly
    after a rewind.
11. **A partial rewind's message.** Default: the paths in brackets, or "(3
    files)" past two, within the 120 characters `cleanTrigger` keeps.
12. **The note after a rewind.** Default: it stays until the next click, with
    no timer, as the river drew it.
13. **The dotted mouth.** Default: dropped. Bring it back only if the
    document pages come to report unsaved buffers to the shell.

## Implementation notes

Checked against claerbout main at 6e71ac3 and knuth main at a426e11.

Rough size: three evenings. About 400 lines of shell code, the page at
about 1,100 (the mockup's rendering without its sample data, plus the
protocol), about 60 lines in each app, and about 300 lines of tests.

### Corrections to the designers' and judges' notes

- **The direction of `diff-tree`.** The buildable judge's notes say to
  check out the M and D paths and unlink the A paths of `diff-tree <tip>
  <target>`. It is the other way round: A and M (and T) are written, D
  removed. Checked in a scratch repository.
- **When the record begins.** The river's empty state said the record
  "begins at your next cell run". `commit()` commits unconditionally when
  there is no tip, so the first commit lands at session open, when the first
  window moves onto the project. The empty states now say so, and a
  repository with main and no record is shown only while a guard holds
  (waiting for a rebase, say).
- **The mouth.** The river's `now {changed}` event cannot be derived; see
  the recommendation.
- **Two-shell guards.** The timeline read an unclosed "plass: session open"
  as Plass being open. Session open and close commit only when the tree
  changed, and a crash leaves no close, so that is unreliable; presence files
  replace it (open question 5).
- **`.gitignore`.** None of the three noticed that `prepare()` runs once per
  launch; see the rules.

### File by file

**claerbout/autosave.js:**
- `Project.commit(trigger, {always})`: with `always`, skip the unchanged
  check (for "rewind to").
- `Project.compare(target, paths)` and `Project.rewind({target, tip, paths,
  anyway, flush, onStep})`, each queued with `this.run`. Inside the rewind's
  job, call `commit()` directly, never `autosave()`, which would queue behind
  itself. Clear `this.prepared` after the write.
- `Autosave.why(window)`: the reason a window has no project. Today
  `rootFor` only logs it (1163-1222); keep the reason in `this.roots`
  beside the null.
- An `onCommit` callback in `attach()`'s options, called with each landed
  commit, for the `history` events.
- The presence files, written in `join` and `leave` (1250-1269) and removed
  in `quit`.

**claerbout/history.js** (new, about 250 lines): the graph (the log above
and its parsing), ties, `commit`, `blob`, and the subject parser
("<app>: cell run [4] (error)" → `{app, trigger, cells, error}`). It only
reads git; it never writes.

**claerbout/main.js:**
- `servePage` (449-468): the `/_claerbout/` root first.
- `openHistory(root, at)`, a `historyWindows` map (window → root), and
  `answerHistory`. The IPC handler (1013-1020) routes a History window's
  requests there.
- In `answer()` (910): `case 'history'` (action `open` only, from a document
  window) and `case 'flushed'`, which resolves the pending flush by id.
- The menu: View › History… in `buildMenu` (1169-1222).
- The 2-second check per open project, and the reload on another app's
  "rewind to".

**claerbout/preload.js:** unchanged.

**claerbout/history.html** (new): the recommended mockup's page, minus the
states card and the sample data, talking to the shell.

**knuth:**
- `src/shell.ts`: `openHistory()`; `flush` and `reload` listeners;
  `reportCellRun` takes the error flag (open question 2).
- `src/main.ts`: a History button beside `#update-app` (86), hidden when the
  shell answers null.
- `src/document-view.ts`: a reload from disk that keeps the session and calls
  `markAllStale` (645).

**plass:**
- `src/claerbout.ts`: the same two listeners, and the request.
- `src/toolbar.ts`: a "History…" item in the File menu, beside "Check for
  updates…" (756-758).

**Tests:**
- `test/autosave.test.mjs`, in temporary repositories:
  - a rewind leaves HEAD, the user's branch and index as they were;
  - "rewind from" lands only when the tree changed; "rewind to" lands even
    when its tree equals the tip;
  - removed paths and their empty folders go;
  - a partial rewind writes only its paths;
  - the manifest is untouched and untracked/ survives;
  - mtimes of files outside the write set are unchanged;
  - an `A` path over an ignored file is skipped;
  - a gitlink is left alone;
  - a `.gitignore` without `/untracked/` gets its line back;
  - a refusal under each guard, and `moved`.
- `test/history.test.mjs`: the record and main come back as two roots;
  exact and near ties; paging; the subject parser.
- The fixture smoke: open History, rewind, and find both commits on the
  record.
- Knuth's `src/shell.test.ts` and Plass's `src/claerbout.test.ts`: the
  `flush` → `flushed` handshake and the reload.

## Built (2026-10-02)

The view is in the shell, on claerbout's main and unreleased (it ships
with the next tag): `history.js` (the graph, a commit, a blob, the
preview and the rewind, all of it runnable under `node --test`),
`history/history.html` (the page), and the hooks in `main.js` (the
`_claerbout/` address, View › History… on ⇧⌘H, the History window's
requests, the two-second look, presence). claerbout's README, under "The
history view", is the protocol as built. Two passes: the first built it
to this spec (claerbout `12cca33`, `6ef9af3`), and two reviewers (one on
the rewind's safety in scratch repositories, one on the page against the
recommended mockup) sent it back once (`b19873e`).

Where the build differs from the spec above:

- **`save` and `saved`, not `flush` and `flushed`,** and no read-only
  hold. A window that answers `{ok: false}` refuses the rewind; one that
  does not answer within 3 seconds is passed over and named: the card
  says in amber that it was not saved first and must be reopened, since
  a page that does not answer `save` does not answer `reload` either.
- **One log, not `--all`:** the user's branches with every record left
  out, and this working tree's record by name.
- **The full sha in "rewind to"** (open question 3); the page shows
  seven.
- **A fourth refusal, `invalid`.** Every path the target holds is checked
  before anything is recorded or touched (no `..`, no absolute path, no
  `.git` in any case or HFS+ spelling, nothing under a link or a nested
  repository of the same commit), then by git's own `read-tree`. The
  record never makes such a path, so a commit holding one is refused
  whole.
- **Removals first.** A file that became a folder, or a folder that
  became a file, is written once its removal clears the way, so "rewind
  to" holds the target's tree. Every removal and write walks from the
  root with `lstat` and goes through no link.
- **`.gitignore`:** the record prepares again as soon as the write step
  ends, finished or not, not at "rewind to"; a `.gitignore` that is a
  link in the target is left alone.
- **Paths compared as the volume compares names:** `Untracked/` is
  `untracked/` on a Mac.
- **The guards' reasons are sentences** ("a merge is in progress on
  main"), in the log and in the page alike.

What the apps still owe (the shell side is ready for each):

- **Answering `save` and `reload`.** On `save {id, reason: 'rewind'}`,
  write the open document if it has changes and answer `{type: 'saved',
  id}` (or `ok: false, error` when it could not). On `reload {id, paths,
  reason: 'rewind', to, app?}`, re-read the document if its path is in
  `paths`: Knuth keeping its session and marking every cell stale
  (`markAllStale`), Plass reloading the paper. Until then every rewind
  waits 3 seconds at the save step and its card says to reopen the
  document.
- **A History button:** `{type: 'history', action: 'open', at?}`, from a
  rail button in Knuth and an item in Plass's File menu, hidden when the
  shell answers `null` (an older shell).
- **The error notice** (open question 2): Knuth sends `cell run [4]
  (error)` when a reported cell raised, so the river draws a red ring.

And before either app sees any of it: the claerbout tag, then each
app's pin moved to it.

## What the recommended mockup shows

Open `history-recommended.html` by double-clicking it. The states card at
the bottom left is mockup chrome, not the shell.

- **At rest:** the morning in Runs. Folds say what they caught, and two red
  rings mark runs that raised.
- **A node selected:** the cell strip lights cell 8; "Rewinding here" says
  cell 9 comes out and cells 7 and 8 go back; paper.typ is named as open in
  Plass. Hover the node: a second click rewinds.
- **An error run:** 09:17, its traceback named in the card.
- **Rewinding:** the hint, then the steps.
- **After a rewind:** the ring, the blue node and the arc. Press Undo.
- **Your branch:** main as a tributary, tied by its files; a rewind to it
  leaves the files main lacks.
- **Record paused:** the pill, and the button that waits.
- **Plass opened meanwhile:** press Rewind for the `other-app` refusal.
- **Long history:** 12 days folded, with raised runs counted, and the strip
  at the edge.
- **No record:** the four reasons, said in words.

Every state, the rewind, undo, click-again (a double-click selects and does
not rewind), the refusal, ⌥↑ ⌥↓ and the zoom levels were checked in headless
Chromium at 1440 × 900, 1100 × 760 and 820 × 700, with no console errors and
no sideways scroll.
