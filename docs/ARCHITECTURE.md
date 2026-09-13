# Architecture

How the plugin is put together and why. For the file format it produces, see
[DATA-FORMAT.md](DATA-FORMAT.md); for building and testing, see
[DEVELOPMENT.md](DEVELOPMENT.md).

Zotero Git Sync is a sibling of [Zotero GitHub Sync](https://github.com/situkangsayur/zotero-github-plugin).
The exporter, importer, three-way planner, review panel and toolbar button are shared code
(copied, not a library), and both write the same repository format. What differs is the
transport: the GitHub plugin talks to GitHub's REST API, this one runs the `git` installed on
the computer, so it works with any host git can reach.

## Module map

Zotero loads `bootstrap.js` into a per-plugin sandbox and calls `startup()`,
`onMainWindowLoad()`, `onMainWindowUnload()` and `shutdown()`. `bootstrap.js` loads every
file in `src/` into that same sandbox with `Services.scriptloader.loadSubScript()`, so the
modules share one scope. `src/core.js` declares the `ZoteroGitSync` namespace; every other
file hangs one object off it.

```
bootstrap.js            Zotero lifecycle hooks
└── src/
    ├── core.js         namespace, init/shutdown, localized strings
    ├── utils.js        pure helpers: hashing, remote URL parsing, cancel token
    ├── files.js        attachment files on disk: hashing, hash cache
    ├── prefs.js        preference access, optional HTTPS token storage
    ├── git.js          finding git, running it, the local bare repository, Git LFS
    ├── planner.js      three-way comparison: what to push, delete, import or ask about
    ├── state.js        what this computer last synced, per repository
    ├── exporter.js     Zotero library -> repository files
    ├── importer.js     repository files -> Zotero library
    ├── sync.js         analyse, decide, act; scheduling
    ├── review.js       review panel inside the main window
    └── ui.js           toolbar button, menus
```

`git.js` is the only file that starts processes; `planner.js` and most of `utils.js` are
pure and tested under Node. `core.js` assigns `Zotero.GitSync = this` as the bridge to the
preference pane, which runs in another window.

## Running git

`Git.find()` locates the executable: the *git program* preference if set, otherwise `PATH`
plus the usual install directories (`/opt/homebrew/bin`, `/usr/local/bin` for macOS GUI apps
that don't inherit the shell's `PATH`; `Program Files\Git\cmd` on Windows).

`Repository.run()` wraps Firefox's `Subprocess.sys.mjs`:

- **stdout and stderr are drained concurrently** with writing stdin. Subprocess stops
  reading a pipe once 32 KB sit unread, so writing a large input before reading the output
  would deadlock against git.
- **Buffers are copied before writing** — `stdin.write()` transfers ownership of an
  `ArrayBuffer`, which would otherwise detach the exporter's data.
- **No prompts, ever.** `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`. A network
  command is killed after three minutes without output (the symptom of a hidden password
  prompt); a local command has a fixed timeout.
- **Cancel kills the process.** The cancel token's listener calls `proc.kill()`.
- **Messages people can act on.** `Git.explain()` recognises the stderr of the usual
  failures — unknown SSH host key, rejected key, rejected HTTPS credentials, repository not
  found, network, size limits, protected branches, git-lfs missing — and says what to do.
  URLs are stripped of credentials before anything is shown or logged. `LANGUAGE=en` keeps
  git's messages recognisable.
- **No hooks.** `core.hooksPath` points at a directory that doesn't exist, so a global hooks
  path meant for the user's working copies never runs here, and pushes use `--no-verify`.

### Authentication

The plugin stores nothing for SSH remotes or HTTPS remotes with a credential helper: git
signs in exactly as it does in a terminal. For HTTPS hosts without a helper, an access token
in the login manager is passed as `http.<origin>.extraHeader` through `GIT_CONFIG_COUNT` /
`GIT_CONFIG_KEY_n` environment variables — not on the command line, where other users could
read it with `ps`, and scoped to the remote's own origin so an LFS storage redirect never
receives it.

## The local repository is bare

The local copy (`<Zotero data directory>/git-sync/<name>.git` by default) has no working
tree. Attachment files already exist in Zotero's storage directory; a checkout would be a
third copy on disk. Commits are built with plumbing, the same shape as the GitHub plugin's
blobs → tree → commit → ref:

| Step | Command |
| --- | --- |
| Remote state | `git fetch origin +refs/heads/<branch>:refs/remotes/origin/<branch>`, then `ls-tree -r -z --long` |
| Text files (JSON, Markdown, LFS pointers) | one `git fast-import` stream of blobs, checked with `cat-file --batch-check` |
| Attachment files | `git hash-object -w --no-filters --stdin-paths` — git reads storage directly; each returned SHA must equal the hash the sync computed |
| Tree | `read-tree <head>` + `update-index -z --index-info` + `write-tree`, on a private `GIT_INDEX_FILE` |
| Commit | `git commit-tree -p <head> -F -` |
| Publish | `git push --porcelain origin <commit>:refs/heads/<branch>` |

An empty remote simply has no branch: the first commit has no parent and the push creates
the branch. Reading back uses `git cat-file --batch` (one process for any number of item
records) and `git cat-file blob` streamed to a temporary file for attachments.

`gc.auto` is off while a sync builds objects; `git gc --auto` runs after a successful sync.

## The sync pipeline

`Sync.syncNow()` → `_runSyncWithRetry()` → `_runSync()`, in three stages.

**Analyse.** `Exporter.build()` returns a map of repository paths to generated bytes or
attachment sources (path, size, mtime) plus *keep prefixes* for attachments whose file isn't
on this computer. The branch is fetched and listed. Every exported file is hashed with Git's
blob hash — attachments from the hash cache when size and mtime are unchanged, LFS files as
the pointer that wraps their SHA-256. `Planner.plan()` compares local, remote and the base
this computer recorded after its last sync:

| local vs remote vs base | Action |
| --- | --- |
| local = remote | nothing |
| remote = base, local differs | push |
| local gone, remote = base | delete (if the path is on `files.json`) |
| local = base, remote differs, or only on the remote | incoming |
| all three differ | conflict |
| remote gone, local still there | restore |
| no base, both differ | diverged: item dates decide, otherwise conflict |

**Decide.** Nothing to decide: go on. A manual sync with decisions opens the review panel;
a background sync takes no decision and leaves those paths pending on the toolbar button.
Accepted changes are imported first (`Importer.applyIncoming()`) and the sync restarts with
the same decisions, since the library changed.

**Act.**

1. **LFS first.** Objects for LFS pointers in the push set are uploaded before any commit
   that references them is pushed (see below).
2. **Text.** Every changed text file is stored with one `fast-import`. On a first sync of a
   library with many attachments, this becomes its own commit and push, so the metadata
   reaches the server before any PDF.
3. **Attachments in checkpoints.** Files are stored 200 files / 64 MB per `hash-object`
   process; every 100 MB or 1,000 files the pending entries become a commit that is pushed.
   A cancelled or failed first sync keeps every checkpoint already pushed.
4. **Final commit** with the remaining files, `files.json` and the deletions.
5. **Record** the new base (`Planner.nextBase()`): a path is recorded only where both sides
   agree now, and undecided paths keep their old base so the same question returns.

Objects the fetched branch already has aren't stored again — a renamed Markdown note costs
a tree entry.

Push progress comes from git's own `Writing objects: NN%` lines on stderr and is spread
over the bytes of the checkpoint being pushed.

### Retrying a moved branch

A push is refused when the branch no longer points at the commit's parent — another
computer synced in between. The rejected porcelain line (`non-fast-forward`, `fetch first`)
marks the error `branchMoved`, and `_runSyncWithRetry()` redoes the sync once: fetch, plan
against the new head, push. Everything already on the branch is skipped.

### Pruning only touches our own files

Two records must agree before anything is deleted: `.zotero-sync/files.json` (paths the
plugin wrote on its last full sync) and this computer's base (it synced that path, and the
branch still holds exactly that version). A computer with no base deletes nothing. Partial
syncs (selected items, a collection) never delete.

### Files that aren't on this computer

With "download files as needed", an attachment can exist in the library without its file.
The exporter marks such attachments with keep prefixes; whatever an earlier sync committed
for them stays, still listed as managed.

## Git LFS

`git-lfs` is used as a client, not reimplemented. git-lfs uploads from its own object
directory, so `Repository.lfsUpload()`:

1. copies each file into `lfs/objects/<aa>/<bb>/<oid>` of the bare repository (checking the
   size after copying),
2. runs `git lfs push --object-id origin <oid>…` in batches of 100 — git-lfs skips objects
   the server already has and handles authentication (SSH `git-lfs-authenticate` or HTTPS),
3. deletes the staged copies again.

Downloads pipe the pointer into `git lfs smudge <path>` and stream the output to a
temporary file, check the size against the pointer, and remove git-lfs's cached copy. The
tree gets exactly what git-lfs would commit: a pointer blob, with
`attachments-lfs/.gitattributes` marking the directory, so an ordinary `git clone` with
git-lfs installed checks out the real files.

If git-lfs isn't installed, a sync that needs it fails with a message saying so, before
anything is pushed; an import skips LFS files with a warning per file.

## Credentials and local state

| What | Where |
| --- | --- |
| Optional HTTPS token | Firefox login manager, origin `chrome://zotero-git-sync` |
| Settings | `extensions.zotero-git-sync.*` preferences |
| Last-synced base per repository/branch/base path | `<profile>/zotero-git-sync/state/<name>.json` |
| Attachment hash cache | `<profile>/zotero-git-sync/hash-cache.json` |
| Local bare repository | `<data directory>/git-sync/<name>.git` (setting: *Local copy of the repository*) |

The local repository can be deleted while Zotero is closed; the next sync fetches it again.
The base can't be recovered from it — without the state file a computer syncs cautiously,
as if new.

## Triggers, UI and localization

Identical to the GitHub plugin: toolbar button, Tools menu, item and collection context
menus, interval / on-change (debounced) / startup / after-Zotero-sync triggers, passive
notifications instead of modal alerts, and a plain string table with English and
Indonesian in `core.js`.

## Differences from Zotero GitHub Sync

| | GitHub Sync | Git Sync |
| --- | --- | --- |
| Transport | GitHub REST (Git Data API, LFS batch API) | system `git` and `git-lfs` |
| Hosts | GitHub, GitHub Enterprise | anything git can push to |
| Auth | fine-grained token | SSH key/agent or credential helper; optional token |
| Rate limiting | paced below GitHub's secondary limits | none needed |
| Creates the repository | yes | no — create it on the host first |
| Local disk | hash cache only | also the bare repository (compressed history) |
| Reading many records | one API request each | one `cat-file --batch` |
