# Coauthoring over the record: 2026-10-02

Taylor, thinking it through: "whether it would be productive to use auto git
pushing and pulling to work with a coauthor on a paper or project." And at
the end: "it's hard to tell whether it'll actually be nice. but i think this
is as good as it gets for a starting point for coauthoring papers and
documents via auto git. i think it's auto push and auto pull until a
conflict."

This is the design record and the place to start. Nothing here is built.
It sits on the autosave record (`docs/AUTOSAVE.md`, the shell's
`autosave.js`) and on Plass's editorial comments
(`plass/src/editor-comments-format.ts`), and it is one design for Knuth and
Plass both, since the record and the history view already are.

## The shape

Two writers, two tracks. Each writer's track is their record branch, the
one the shell already keeps, pushed to the shared remote and fetched from
it on every tick of the record (every minute something changed, every
cell run, session open and close). The witness schedule in
`docs/AUTOSAVE.md` (every ~10 commits, every 30 minutes) is for pinning
time and is too slow here: most collisions come from neither side knowing
the other was in a paragraph, and the warning below only fires if the
fetch already happened. The draft is the last node both tracks pass
through. Everything after it is a proposal.

- **Auto push, auto fetch, auto merge, until a conflict.** The merge is
  git's own three-way merge from the last shared node: every change only
  one side made goes in on its own, and the merge stops where both sides
  changed the same line. That stop is a merge conflict, and the shell
  resolves it into the document in a form both writers see the same way
  (below).
- **The tracks meet.** A merge is a commit on the record branch with two
  parents, our tip and the coauthor's tip, and the tree is whatever the
  merge produced. When we have nothing new of our own, no merge node is
  made: the next commit's parent is simply the coauthor's commit, and both
  tracks pass through it (a fast-forward). Either way the next merge
  starts from that node and only shows what each side did since, so the
  comparison stays small. The history river draws the joins.
- **Going back stays going forward.** A rewind is a new commit whose tree
  matches an older one (history.js). Nothing is rewritten, the shared node
  stays shared, and putting a line back is just the next edit, which the
  next merge treats as one.
- **No main in the daily flow.** The draft is the shared node; a tag marks
  a submitted version. The user's own HEAD, branch and index are still
  never touched: everything here is on the record branches and in the
  working tree.
- **Not live.** A change arrives after the tick, the push and the other
  side's fetch, so in minutes. That suits handing a paper back and forth.
  Two people typing in the same line at the same time want a CRDT, not
  git, and this does not try to be that.

The pattern is older git: two trees pulling from each other, the way the
kernel is run, not a branch per task landing on main. The merge node means
"the shell put it in," and what it meant before, "I read it," comes back as
a mark on each line that changed on the other side (below).

## The unit is the line

Taylor: "lets actually make it one line everywhere then. then it's line in
plass (not block) and line in knuth."

The line is git's unit, so this is the one rule with nothing added: a
three-way merge conflicts exactly when both writers changed the same line,
in a `.typ`, a `.md` or a `.py`, with no merge driver and no pass after.
And a line is already a paragraph in both apps:

- **Plass.** The `.typ` and `.md` serializers write each paragraph on one
  line, and a heading, a list item or a display equation is a line of its
  own. Nothing to change.
- **Knuth.** A text cell holds its markdown behind `# `, one paragraph per
  line (`src/prose/md-serializer.ts`, trimmed from Plass's), with a `#`
  line between paragraphs. A text cell goes on holding as many paragraphs
  as it likes (the first draft of this record had a cell per line; Taylor:
  "the multi-paragraph text cells is actually useful. scratch that then").
  A code cell is many lines and merges by line, the way software is
  merged.
- **So the document is a column of lines,** some of which run, and the
  unit of conflict, of the "new since you looked" mark and of the rail's
  marks is the same thing in both apps.

Why not one sentence per line, which is what git-for-papers people
usually do? It would let two writers change different sentences of one
paragraph with no conflict. The paragraph then may not read as one thought
any more, and nobody was told to reread it. A paragraph per line means
every shared paragraph is reread by a person.

## Comments live in the document

Taylor: "i don't like it being on github only. i think it going in the doc
is the only choice."

GitHub's pull-request comments live in GitHub's database, pinned to a file,
a line and a commit; the repository has none of them, and a clone gets the
text and the history and no comments. The other places a comment can live
are the document, a file beside it, or git notes (a note on a whole commit,
not pushed by default, used by nobody for this). In the document is the
one that needs nothing new.

Plass already has it: an editorial comment is the one approved exception
to "the page shows only printed content". It lives in the working file, in
`.typ` as a framed run of `// | ` lines and in `.md` as a tagged HTML
comment, shows on the page as a strip that is visibly not paper, and is
absent from every export (`plass/docs/COMMENTS-AND-APPEARANCE-HANDOFF.md`).
Knuth takes the same thing:

- **A comment is Plass's frame,** in Knuth inside a text cell's `# ` lines,
  placed after the paragraph or code cell it is about. It travels with a
  fetch like everything else, shows up in the coauthor's document where
  they will look, and the export (and `python file.py`) ignores it.
- **A thread is consecutive frames.** Resolving is deleting them. The
  record keeps every version anyway, so the history view can still show
  what was said.
- **A suggested change is an edit.** No separate form: the coauthor
  rewrites the line on their track, and the merge brings it over or
  conflicts.

Plass's comment carries only a payload. Shared, it needs the writer's
name, by convention ("Jo: ...") or as a field; open below.

## The back and forth

You and Jo, both at the draft. You rewrite paragraph 2. The record commits
and pushes. Jo's shell fetches and merges: your paragraph 2 replaces hers,
since only you changed it, and it gets the "new since you looked" mark.
She reads it, has a comment and a different wording, and writes both on
her track: the paragraph her way, a comment under it. Push.

Your shell fetches and merges. Her wording replaces yours (only she
changed it since the shared node, which is your commit) and her comment
appears under it, marked new. You agree, delete the comment, push; or you
edit the paragraph a third way and reply with a comment of your own, push,
her turn. It ends when someone's fetch brings nothing to reply to: the
comments are gone, the text is agreed, and the node both tracks are on is
the draft.

If you had gone on in paragraph 4 meanwhile, the merge still has nothing
to decide: her 2, your 4, one merge node.

The one hard case is both of you rewriting the same line before either
fetched. Then the merge conflicts. The editor heads it off where it can:
when you start typing in a line that changed on Jo's track since the last
shared node, it says so.

## The conflict

Taylor: "that's just what happens in the editor when there's a merge
conflict." And: "my feeling about what should happen is that there's a
merge conflict and what happens is it auto-resolves to something that is
clear in the document who wrote what and that there was a conflict and
renders the exact same thing on both coauthors' plass or shows the same
thing on both knuth."

So the conflict is resolved by the shell, into the document, in a special
comment of its own kind, and the two shells write it byte for byte the
same:

- **The form.** A frame like the comment's, holding both versions, each
  headed by its writer's name. In a `.md` or a Knuth text cell:

  ```
  <!-- claerbout:conflict
  Jo:
  The effect holds in every sample we ran.
  Taylor:
  The effect held in all four samples.
  -->
  ```

  In a `.typ` the `// ` frame, and in a Knuth code cell `# ` lines, so the
  kernel skips both versions rather than running one. The frame replaces
  the conflicting line; nothing of that line is live until a person
  resolves it.
- **The same on both sides.** Each shell builds the frame from the same
  three things, the line at the shared node, ours and theirs, and orders
  the versions by writer's name, never by which side is "ours". So Jo's
  shell and Taylor's write identical bytes, their merge nodes have the
  same tree, and when each fetches the other's merge node the frame
  merges clean. Nothing in it depends on who merged first.
- **Who wrote what, and that there was one.** The names are in the frame,
  and the frame is in the tree, so the history has the conflict and both
  sides of it. The page shows the two versions as a strip that is visibly
  not paper, each with its name, marked new; the rail marks the line.
- **Resolving is editing.** Keep one version, or write a third, and delete
  the frame. The next commit carries the resolution to the other track as
  a one-sided change. If both resolve differently at once, the result is
  one more frame, not a loss.
- **Export strips the frame,** as it strips comments. An unresolved
  paragraph does not print. That is the honest reading of "not agreed".

What this does not change: **never into the line being edited.** Every
other line updates as soon as the merge lands. The one with the cursor
waits until the cursor leaves it, and the file on disk holds our version
of it until then. That is the whole "don't pull into a dirty tree" rule,
at the size of a line, and it keeps the cursor and the undo stack where
they are.

One exception to the one rule, and one thing it leaves to decide:

- **Knuth's machine-owned lines never get a frame.** The `#-> ` outputs
  under a cell and the figures in `figs/` (`docs/DESIGN.md`, outputs
  inside the `.py`) differ whenever both writers ran the same cell. A
  conflict there takes ours and lists the cell as stale, with the badge
  an edited cell already gets and the same "run stale", and the next run
  decides. (Taylor: "lets just list the cell as stale.")
- **A code cell both writers changed on different lines** merges clean
  under the one rule, as software does. Whether the whole cell should be
  flagged anyway, because the kernel runs it whole, is open.

## New since you looked

The merge node no longer means "I read it," since the shell made it. So
each line that changed on the coauthor's side carries a mark, on the line
and on the rail, that clears when you look at it (it scrolls into view
and sits there) or edit it. A comment or a conflict frame arriving is
marked the same way. The mark is the shell's state, not the document's:
it is about one reader.

## The diff page

The pull-request page without the asking: our document against the
coauthor's since the shared node, line by line, and after a merge, what
arrived and what conflicted. With auto merge it is less the center than
it was in the first sketch, since most of what it would show has already
landed in the document and is marked there. The history river is where
the two tracks and their joins are drawn, with the coauthor's last push
time, which is the cheapest thing that prevents collisions at all.

## What it can't catch

Jo changes the claim in section 2. Section 4 still argues from the old
one. Git sees two clean lines and merges. Only the mark on section 2 and a
reread catch it. Same as software, where a rename merges cleanly and the
kernel fails in a cell nobody touched. Prose has it worse, because the
parts of a paper touch by design, and nothing like a test says the merge
is right.

## Prior art

Math, physics and CS people often keep a LaTeX paper in git, almost all on
one shared branch, pushing and pulling by hand and fixing conflicts in a
text editor. Manubot writes papers as GitHub pull requests, one file per
section, one sentence per line, a build after every merge. Jupyter's
nbdime diffs and merges notebooks cell by cell. Overleaf won the mainstream
by being live. Per-person tracks pulling from each other is how the kernel
is run and rare elsewhere.

## Plumbing

What the shell would do, in the order a commit flows:

- **Branches.** Today's name, `claerbout-autosave`, cannot be shared by
  two people on one remote. Each writer's branch needs their name in it,
  and the commits need the writer's git identity instead of
  `Claerbout Autosave`, since who wrote a line is part of what the
  history is for, and the conflict frame needs the name too.
- **Push.** The witness push from `docs/AUTOSAVE.md`, only the record
  branch, retried quietly offline, but on every tick once a coauthor is
  set rather than on the witness schedule. Not built; writing it was
  refused twice by the permission check as an automatic push from inside
  the app, so it is Taylor's to build or to authorise.
- **Fetch.** The coauthor's branch, on every tick, before the merge.
- **Merge.** `git merge-tree --write-tree <ours> <theirs>` (git 2.38 and
  later; this Mac has 2.50) does the three-way merge in the object store
  and reports the conflicting lines, without touching the working tree
  or the index. The shell turns each conflict into a frame, writes the
  changed files into the working tree, except the line being edited, and
  the record commits with two parents (or moves onto the coauthor's
  commit when nothing of ours was new). All plumbing; the user's HEAD and
  index are never touched, as now.
- **The editor.** Plass renders comment frames already; the conflict
  frame is one more kind, with two versions and two names. Knuth's text
  cells take both frames through the same ProseMirror schema Plass's
  prose came from (`src/prose/`).
- **Export.** Plass strips comments from every export already, and strips
  the conflict frame the same way. Knuth's exports and `knuth run` do the
  same for both.

## Open

- **A code cell both changed on different lines:** clean merge, or
  flagged whole.
- **Who said it.** The comment form needs the writer's name, the way the
  conflict frame has it.
- **Branch names on the remote,** and the identity on the commits.
- **Whether it is nice.** Taylor: "it's hard to tell whether it'll
  actually be nice." The way to find out before any of it ships: two
  checkouts of one paper on one Mac, two shells with their own state
  folders and ports (the way `app/smoke.mjs` runs a spare), a bare
  repository in a folder as the remote, and a morning of writing in both.
