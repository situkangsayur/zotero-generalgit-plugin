# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5] — 2026-09-25

### Fixed

Found by running the 0.1.4 fixes in a real Zotero (`scripts/fixes-test/`), which is new here:

- **A deleted item came back as an import when pruning was off.** Its files stayed on the server,
  as asked, but the sync stopped remembering them, so the next sync offered them as new — and a
  later sync with pruning on could no longer recognise them as its own to remove. They stay in
  the sync's record and in `.zotero-sync/files.json`.
- **"Keep both" never worked for a file in a subfolder.** The new attachment was named after the
  file's whole path (`page/style.css`), which is not a file name, so it failed with
  `NS_ERROR_FILE_UNRECOGNIZED_PATH`. It uses the file's own name now, and when one attachment
  keeps several files each copy is titled with the file it came from.

### Added

- `scripts/fixes-test/`: a headless end-to-end check of all of this against a throwaway
  repository — pruning on and off, "keep both" for a multi-file attachment, and an import of a
  branch whose tree holds `<attachment>/../escape.txt`.

## [0.1.4] — 2026-09-25

### Fixed

- **The "Remove files from the repository when their items are deleted" preference did nothing.**
  It was read but never used, so a full sync deleted files on the server even with the box
  unchecked. The planner now honours it: with pruning off, files whose items are gone here stay
  on the server and are counted as unchanged. Reported by a reader of the source.
- **Repository paths are checked before they become local paths.** A file path from the Git tree
  was joined onto the attachment's storage folder as-is; a component of `.`, `..` or an empty
  segment could have written outside that folder. Git does not normally allow such a tree, but
  the path comes from the server, so each segment is now validated and a bad one is reported as
  a failure instead of written.
- **"Keep both" could lose the other files of a multi-file attachment.** After importing the
  repository's copy, the plugin deleted its temporary folder recursively — and a web snapshot's
  files share one temporary folder, so the files not yet imported went with it. The folder is
  now removed once, after every copy has been imported.

## [0.1.3] — 2026-09-14

### Fixed

- The collection context menu and Tools menu commands did nothing on Zotero 10: they called
  `ZoteroPane.getSelectedCollection()`, which Zotero 10 removed (it now throws). The plugin uses
  `getSelectedCollections()` where available.

## [0.1.2] — 2026-09-13

### Fixed

- When the server rejects an access token that *is* saved, the error now says so — naming the
  user name it was sent with — instead of suggesting to enter a token, which read as if the
  saved token had been ignored.

## [0.1.1] — 2026-09-13

### Changed

- **Git LFS is optional and off by default.** Every attachment is committed to Git itself, up
  to *Largest file to commit to Git itself* (100 MB). git-lfs is no longer needed to sync a
  library with large files. Existing installations that never changed the setting switch to
  the new default.
- **No git-lfs, no failure.** With Git LFS turned on but git-lfs missing, the sync now runs
  without LFS and reports it as a warning, instead of stopping with "Git LFS is not installed"
  and never syncing.
- Test connection no longer warns about a missing git-lfs when LFS is off.

### Fixed

- Error messages for git commands without a subcommand read "git git: …".
- A sync that first imported accepted changes dropped the warnings of that import (files it
  couldn't restore, for example) from its result and from Settings → Git Sync.

## [0.1.0] — 2026-09-13

First release. Built from Zotero GitHub Sync 0.3.0, whose exporter, importer, three-way
planner, review panel and toolbar button it shares, with GitHub's REST API replaced by the
`git` installed on the computer.

### Added

- **Any Git host.** The repository is set by its clone address — SSH (`git@host:path`,
  `ssh://`) or HTTPS — so GitLab, Gitea, Forgejo, Codeberg, Bitbucket and self-hosted servers
  all work the same way.
- **The system's git does the talking.** SSH keys and agents and HTTPS credential helpers
  work unchanged. For HTTPS hosts without a helper, an optional access token is kept in
  Zotero's password manager and passed to git through the environment, scoped to the
  repository's own origin. git never waits on a prompt: a command that goes quiet for three
  minutes is stopped with an explanation.
- **Bare local repository** under the Zotero data directory. Commits are built with git
  plumbing (`fast-import`, `hash-object`, `update-index`, `write-tree`, `commit-tree`), so
  attachments are never checked out as a second copy on disk.
- **Git LFS through git-lfs**: `git lfs push --object-id` before the pointers are pushed,
  `git lfs smudge` to restore. Staged and cached LFS copies are removed afterwards.
- **Checkpoint pushes** during a large first sync (every 100 MB or 1,000 files), with push
  progress taken from git's own output.
- **Readable errors** for the usual failures: unknown SSH host key, rejected key, rejected
  HTTPS credentials, missing repository, network, host size limits, protected branches,
  git-lfs not installed.
- **Test connection** in the settings: git and git-lfs versions, the commit identity, and
  the branches the repository has.
- Settings for the git program, the local repository location, the repository's web page,
  and the largest file committed to Git without LFS.
- `npm run test:git`: `src/git.js` against the real git and git-lfs under Node.
- `scripts/conflict-test/` runs two computers and an import against a local bare repository
  by default, or any remote, optionally with a token and Git LFS.

### Differences from Zotero GitHub Sync 0.3.0

- The repository must exist before the first sync; the plugin can't create it.
- No rate limiting (not needed), no GitHub Enterprise API URL, no LFS URL setting (git-lfs
  works it out, or reads `lfs.url` from git's configuration).
- Menu and panel texts say "Git" and "repository" instead of "GitHub"; toolbar icon and all
  identifiers differ, so both plugins can be installed side by side.
