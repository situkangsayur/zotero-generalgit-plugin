# Development

## Requirements

Node 18 or newer, git (and git-lfs for the LFS tests), and a Zotero 7+ installation to test
against. There is nothing to `npm install`.

## Build

```bash
npm run build
```

Writes `build/zotero-git-sync-<version>.xpi` and prints its size and SHA-256. The archive
contains `manifest.json`, `bootstrap.js`, `prefs.js`, `README.md`, `LICENSE`, `src/` and
`content/`; `docs/`, `scripts/`, `test/` and `package.json` are not shipped.

## Tests

```bash
npm test            # pure logic: planner, URL parsing, hashing, import ordering
npm run test:git    # src/git.js against the real git
```

`test/git.test.mjs` runs `Repository` under Node with `test/shim.mjs`, a small stand-in for
Firefox's `Subprocess`, `IOUtils` and `PathUtils` that keeps the behaviour that matters
(chunked reads, an empty buffer at the end of a pipe). In a temporary directory it creates a
bare "remote" and two local repositories and checks: an empty remote, text through
`fast-import` and files through `hash-object`, paths with tabs and non-ASCII characters, a
push, a second computer fetching, reading back and deleting, a push refused as
`branchMoved`, a missing repository, readable error messages, the HTTPS token environment,
cancelling a running git, 3,000 blobs through one `cat-file --batch`, and — when `git-lfs`
is on `PATH` — an LFS upload, a pointer commit, and a download in a third repository
through `git lfs smudge`.

Set `DEBUG=1` to print every git command.

The shim is not Firefox: anything involving Zotero, the review panel or real pipes has to
run in the application — which is what the scripts below are for.

## Run from source

Zotero can load the plugin straight from this directory:

1. Close Zotero.
2. In the [profile directory](https://www.zotero.org/support/kb/profile_directory), create
   `extensions/zotero-git-sync@situkangsayur.github.io` — a **file** whose entire content is
   the absolute path of this directory.
3. In the profile's `prefs.js`, empty `extensions.lastAppBuildId` and
   `extensions.lastAppVersion` so Zotero rescans extensions.
4. Start Zotero with `-ZoteroDebugText -jsconsole`.

After editing `src/`, restart Zotero or disable and re-enable the plugin.

## Debugging

- Plugin log lines start with `[Git Sync]`; every git command is logged as
  `[Git Sync] git <subcommand> …`, and a failing one with its exit code and stderr (URLs
  stripped of credentials).
- **Tools → Developer → Run JavaScript**, with the namespace at `Zotero.GitSync`:

  ```js
  let config = Zotero.GitSync.Prefs.getConfig();
  let repo = await Zotero.GitSync.Sync.openRepository(config);
  let head = await repo.fetch();
  (await repo.listTree(head)).size
  (await repo.run(['log', '--oneline', '-5', head])).stdout
  ```

- The local repository is an ordinary bare repository: inspect it from a terminal with
  `git --git-dir=<Zotero data directory>/git-sync/<name>.git log --stat`.

## Testing two computers and an import

`scripts/conflict-test/` runs three throwaway headless profiles against one repository, one
Zotero launch per step:

| Step | What happens |
| --- | --- |
| A1 | A creates a small library (a PDF with an annotation, a 1.5 MB file) and syncs |
| B1 | B starts empty and syncs: everything is incoming, accepted |
| A2 | A retitles an item, trashes one, adds one |
| B2 | B, behind, retitles the same item and adds a note in a background sync |
| B3 | B reviews: takes the repository's title, imports the addition, doesn't restore the deletion |
| A3 | A accepts B's note |
| X0 | (optional, profile C) a sync without the token must fail with a credentials message |
| C1 | C, empty, runs Import from Git |

The review panel is replaced by a scripted chooser. Each step writes `out/<step>.json`: the
sync result, what the review offered, the library, the repository (items, files, commit
author and count) and the SHA-256 of every file in storage — C1's must equal A3's.

```bash
cd scripts/conflict-test/addon && zip -r /tmp/zgit-conflict-test.xpi . && cd -
scp build/zotero-git-sync-<version>.xpi host:zgit-conflict/zotero-git-sync.xpi
scp /tmp/zgit-conflict-test.xpi host:zgit-conflict/zgit-conflict-test.xpi
scp scripts/conflict-test/run-remote.sh host:zgit-conflict/
ssh host 'cd ~/zgit-conflict && ZGIT_LFS=1 bash run-remote.sh'
```

By default the remote is a bare repository created in `~/zgit-conflict`, so no account is
involved. To test a real host, create an empty repository and add
`ZGIT_REMOTE_URL=<address>`; for an HTTPS host with a token, also
`ZGIT_TOKEN_FILE=<file with the token> ZGIT_HTTPS_USER=<user> ZGIT_STEPS="A1 B1 A2 B2 B3 A3 X0 C1"`.
`ZGIT_LFS=1` needs git-lfs on `PATH` or in `~/zgit-conflict/bin`.

A throwaway Gitea for this runs in one command:

```bash
docker run -d --name zgit-gitea-test -p 3399:3000 \
  -e GITEA__security__INSTALL_LOCK=true -e GITEA__database__DB_TYPE=sqlite3 \
  -e GITEA__server__ROOT_URL=http://<this-host>:3399/ -e GITEA__server__LFS_START_SERVER=true \
  gitea/gitea:1.24
docker exec -u git zgit-gitea-test gitea admin user create --username zottest \
  --password <password> --email zottest@example.com --must-change-password=false
docker exec -u git zgit-gitea-test gitea admin user generate-access-token \
  --username zottest --scopes write:repository,write:user --raw
```

then create the repository with `POST /api/v1/user/repos`.

`scripts/import-test/` imports an existing repository into an empty headless profile and
writes a report; set `ZGIT_REMOTE_URL` (and `ZGIT_BASE_PATH`).

`scripts/fixes-test/` checks the three fixes from the 0.1.4 source review, again against a
bare repository in `~/zgit-fixes`, so no account is involved:

| Step | Profile | What it proves |
| --- | --- | --- |
| F1 | A | A library with a multi-file (snapshot-shaped) attachment reaches the repository |
| F2 | A | With pruning **off**, an item deleted here stays on the server (`deleted` is 0) |
| F3 | A | With pruning **on**, it goes |
| F4 | B | An empty profile imports every file of the snapshot |
| F5 | A | A edits all of the snapshot's files |
| F6 | B | B edited them too and picks "keep both": every repository copy is kept, not just the first, and no `zgit-copy-*` folder is left in temp |
| EVIL | -- | The runner grafts `<attachment>/../escape.txt` into the branch with `git mktree` (git will not build such a path from a worktree, but a tree entry named `..` is just bytes) |
| F7 | C | The import refuses that path: nothing outside the storage folder is written and the warning says so |

```bash
cd scripts/fixes-test/addon && zip -r /tmp/zgit-fixes-test.xpi . && cd -
scp build/zotero-git-sync-<version>.xpi host:zgit-fixes/zotero-git-sync.xpi
scp /tmp/zgit-fixes-test.xpi scripts/fixes-test/run-remote.sh host:zgit-fixes/
ssh host 'cd ~/zgit-fixes && bash run-remote.sh'
```

## Adding things

**A preference.** Default in `prefs.js`, normalized in `Prefs.getConfig()`, a control with
`preference="extensions.zotero-git-sync.<name>"` in `content/preferences.xhtml`.

**A language.** One key in `_strings` in `src/core.js`.

**A recognised git error.** Add a pattern and a hint to `Git.explain()` in `src/git.js`, and
an assertion to `test/git.test.mjs`.

## Code style

Follows the Zotero codebase: tabs, `let` over `const` except for true constants, `else` and
`catch` on their own line, two hyphens rather than an em dash in comments. Comments explain
why, not what.

## Manifest requirements

Zotero 10 refuses a plugin whose `manifest.json` lacks `applications.zotero.id`,
`update_url` or `strict_max_version`, and silently deletes such a sideloaded XPI. Raise
`strict_max_version` in `manifest.json` and `update.json` together.

## Releasing

1. Bump the version in `manifest.json`, `package.json` and `update.json`, and point
   `update_link` at the new release asset.
2. Add a `CHANGELOG.md` entry.
3. Commit, tag `v<version>`, push the tag. `.github/workflows/release.yml` tests, builds and
   attaches the XPI and `update.json` to a GitHub release.
