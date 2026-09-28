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
