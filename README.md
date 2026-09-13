# Zotero Git Sync

Back up your whole Zotero library — metadata, notes, annotations, and the PDFs, books and
other files themselves — to a Git repository on **any Git host**: GitLab, Gitea, Forgejo,
Codeberg, Bitbucket, or your own server. The plugin uses the `git` installed on your
computer, so it signs in exactly the way `git clone` does in your terminal: with your SSH
key or your HTTPS credential helper. Every item becomes a JSON file and a readable Markdown
note, large files go through Git LFS, and every sync is an ordinary Git commit.

Works with Zotero 7 through 10. For GitHub, the sister plugin
[Zotero GitHub Sync](https://github.com/situkangsayur/zotero-github-plugin) needs no git on
the computer; both write the same repository format.

**[Download the latest release](https://github.com/situkangsayur/zotero-generalgit-plugin/releases/latest)** ·
**[Step-by-step tutorial](docs/TUTORIAL.md)** ·
**[Tutorial (Bahasa Indonesia)](docs/TUTORIAL.id.md)**

> **Status: 0.1.1.** Tested on Zotero 10 (Linux, git 2.55, git-lfs 3.8) with a
> scripted run of two computers taking turns on one repository — edits, deletions,
> conflicts on both sides, a background sync while behind — followed by *Import from Git*
> into an empty profile that restored every item and file byte for byte, with one file
> through Git LFS. The whole run passed twice: against a local bare repository, and against
> a Gitea 1.24 server over HTTP with an access token (plus a check that a missing token gives
> a readable error). Not yet tested: GitLab,
> Bitbucket, SSH remotes from inside Zotero, Windows and macOS, Zotero 7–9, group
> libraries, large libraries. See
> [CHANGELOG.md](CHANGELOG.md).

---

## What it does

- **Backs up the whole library.** Items, notes, PDF annotations, tags, collections, saved
  searches, tag colors, and every attachment file: stored PDFs and books, web snapshots,
  images in notes, and linked files.
- **Works with any Git host.** Anything you can `git push` to: GitLab.com or self-managed
  GitLab, Gitea, Forgejo, Codeberg, Bitbucket Cloud, a plain server over SSH.
- **Uses your existing sign-in.** SSH keys and agent, or git's credential helper. For HTTPS
  hosts without a helper you can store an access token in Zotero's password manager.
- **Handles large files without extra tools.** Every file goes into Git itself, up to a size
  you set. Git LFS is optional (off by default) for hosts that refuse large files; if it is on
  but git-lfs isn't installed, the sync carries on without it.
- **Only sends what changed.** Files are hashed with Git's own blob hash and the hashes are
  cached, so an unchanged library makes no commit and reads no PDFs.
- **Survives big first syncs.** Metadata and notes are pushed first; attachment files follow
  in checkpoint commits, each pushed on its own. A cancelled or failed sync keeps what it
  already pushed and the next one carries on.
- **Never overwrites what it can't account for.** It remembers what this computer last
  synced, so it can tell your changes from changes made in the repository or by another
  computer. Anything that needs a decision opens a review: import changes, pick a side in a
  conflict, or keep both.
- **Shows what it's doing.** A toolbar button next to Zotero's own sync button spins while
  syncing, shows the percentage, and turns red when something fails. Right-click to cancel.
- **Restores a library.** *Import from Git* brings items, collections, annotations and files
  back into an empty Zotero on another computer, with the same item keys.

## What it is not

- Not a replacement for Zotero's own sync. Keep using Zotero sync (or WebDAV) between your
  computers; this is a readable, versioned backup you control.
- Not a two-way editor. Changes made to the repository files come back into Zotero only
  when you accept them in a review or run *Import from Git*.
- It doesn't create the repository for you. Create an empty repository on your host first.

## Requirements

- **git** on the computer: any recent version (tested with 2.43 and 2.55; the optional
  HTTPS token needs 2.31 or newer). Windows:
  [Git for Windows](https://git-scm.com/download/win), which includes Git LFS. macOS:
  `xcode-select --install` or Homebrew. Linux: your package manager.
- **git-lfs** is *not* required. Install it ([git-lfs.com](https://git-lfs.com)) only if you
  turn on Git LFS for a host that refuses large files.
- A repository on a Git host.

## Install

1. Download `zotero-git-sync-<version>.xpi` from the
   [releases page](https://github.com/situkangsayur/zotero-generalgit-plugin/releases/latest).
2. In Zotero: **Tools → Plugins**, the gear menu, **Install Plugin From File…**, pick the file.
3. Open **Settings → Git Sync**.

## Set up

### 1. Make sure git can reach the repository

In a terminal, check that git can talk to your repository without asking anything:

```sh
git ls-remote git@gitlab.com:you/zotero-library.git
```

If that prints nothing and no error, you're ready (an empty repository has no branches).
If it asks for a password or a passphrase, the plugin can't answer that prompt — set up an
SSH agent or a credential helper first, or use the token fields below.

| Host | Address to use | Sign-in |
| --- | --- | --- |
| GitLab | `git@gitlab.com:you/repo.git` or `https://gitlab.com/you/repo.git` | SSH key, or a personal access token with `read_repository` and `write_repository` |
| Gitea / Forgejo / Codeberg | `git@codeberg.org:you/repo.git` or `https://codeberg.org/you/repo.git` | SSH key, or an access token with repository read and write |
| Bitbucket Cloud | `git@bitbucket.org:workspace/repo.git` or `https://bitbucket.org/workspace/repo.git` | SSH key, or an access token (user name `x-token-auth`) / app password |
| Your own server | `ssh://git@server/srv/git/zotero.git`, `user@server:zotero.git` | SSH key |

The first SSH connection to a new server must be made once from a terminal, to accept its
host key.

### 2. Configure the plugin

**Settings → Git Sync**:

- **Repository address** — the clone address from your host.
- **Branch** — `main` by default. It is created on the first sync if it doesn't exist.
- **Folder inside the repository** — `zotero` by default, so the library doesn't mix with
  other files. Empty means the repository root.
- **Test connection** — checks git, git-lfs, who commits will be attributed to, and that the
  repository can be read.
- **HTTPS sign-in** — only for `https://` addresses without a credential helper.

### 3. Choose when to sync

Manually from the toolbar button, **Tools → Git Sync**, or the item and collection context
menus; or automatically every N minutes, a few minutes after the library changes, shortly
after Zotero starts, or after Zotero's own sync. Background syncs never ask questions:
anything that needs a decision waits on the toolbar button.

## Repository layout

```
zotero/
├── README.md
├── .zotero-sync/manifest.json, files.json
└── my-library/
    ├── library.json, collections.json, searches.json, settings.json
    ├── index.md
    ├── items/AB/ABCD1234.json          one per top-level item, children included
    ├── notes/A/Attention Is All You Need (ABCD1234).md
    ├── attachments/AB/ABCD1234/paper.pdf
    └── attachments-lfs/AB/ABCD1234/book.pdf   (Git LFS pointer)
```

Details: [docs/DATA-FORMAT.md](docs/DATA-FORMAT.md). The format is shared with Zotero GitHub
Sync, so a repository can move between the two plugins.

### Syncing from more than one computer

Each computer remembers what it last synced. A sync pushes your changes, and when the
repository changed too — another computer synced, or someone edited a file — a manual sync
shows a review of those changes first; a background sync pushes only what is safe and leaves
the rest waiting. A computer that has never synced the repository deletes nothing.

### Deleting files

Only files the plugin itself wrote (listed in `.zotero-sync/files.json`) are ever deleted,
and only when this computer synced them and nothing changed them since. Anything else in the
repository is left alone.

## Large files and host limits

- By default every attachment is committed to Git itself, up to *Largest file to commit to Git
  itself* (100 MB by default — the limit on GitHub and GitLab.com). Larger files are skipped
  with a warning; on a self-hosted server that accepts them, raise the limit.
- Optional: turn on *Store files larger than … with Git LFS* (50 MB by default). That needs
  `git-lfs` on the computer and LFS enabled for the repository. If git-lfs is missing, the
  sync still runs — without LFS — and says so.
- Hosts limit repository size, LFS storage and push size, and the limits differ by host and
  plan. Check your host's documentation before backing up a large library. When the host
  refuses a push, the sync stops with a message saying so; checkpoints already pushed stay.

## Import from Git

**Tools → Git Sync → Import from Git…** reads the repository and adds items missing from the
library, updates items whose repository copy is newer, restores missing attachment files,
and never deletes anything. Use it to set up a new computer from a backup.

## Where things are stored

| What | Where |
| --- | --- |
| Local copy of the repository (bare, compressed history) | `<Zotero data directory>/git-sync/` |
| What this computer last synced | `<profile>/zotero-git-sync/state/` |
| Attachment hash cache | `<profile>/zotero-git-sync/hash-cache.json` |
| Optional HTTPS token | Zotero's password manager |

The local copy holds every file the repository has, compressed — plan for roughly the size
of your attachments again. It can be deleted while Zotero is closed; the next sync fetches
it again.

## Troubleshooting

| Message | What to do |
| --- | --- |
| git was not found | Install git, restart Zotero, or set *git program* under Advanced |
| SSH does not know this server yet | Run `ssh -T git@your-host` once in a terminal and accept the host key |
| The server did not accept an SSH key | Add your public key on the host; load a passphrase-protected key into your SSH agent |
| The server refused the HTTPS credentials | Set up a credential helper, or enter a user name and token under HTTPS sign-in |
| The repository was not found | Check the address; create the repository on the host first |
| stopped responding | git was waiting for a prompt: use an SSH agent or a credential helper |
| Git LFS is turned on but git-lfs is not installed | Sync worked without LFS. Install git-lfs, or turn Git LFS off |
| refused the push because of a size limit | Lower the LFS threshold, skip very large attachments, check the host's limits |

For more detail, turn on **Help → Debug Output Logging**; plugin lines start with
`[Git Sync]`, and every git command it runs is logged (without credentials).

## Development

```sh
npm test            # pure logic under Node
npm run test:git    # src/git.js against the real git (and git-lfs, if installed)
npm run build       # build/zotero-git-sync-<version>.xpi
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Ringkas (Bahasa Indonesia)

**Zotero Git Sync** mencadangkan seluruh pustaka Zotero — metadata, catatan, anotasi, dan
berkas PDF/buku — ke repositori Git di **host apa pun**: GitLab, Gitea, Forgejo, Codeberg,
Bitbucket, atau server sendiri. Plugin memakai `git` yang terpasang di komputer, jadi cara
masuknya sama seperti `git clone` di terminal: kunci SSH atau credential helper HTTPS.

- **Syarat:** cukup git terpasang. git-lfs tidak wajib (Git LFS mati secara bawaan).
- **Langkah:** buat repositori kosong di host → pastikan `git ls-remote <alamat>` jalan
  tanpa bertanya password → pasang XPI (Tools → Plugins → Install Plugin From File…) → isi
  *Repository address* di Settings → Git Sync → *Test connection* → klik tombol Git Sync.
- **Beberapa komputer:** tiap komputer mengingat sinkron terakhirnya; perubahan dari komputer
  lain ditampilkan untuk ditinjau, tidak pernah ditimpa diam-diam.
- **Memulihkan:** Tools → Git Sync → Import from Git… di komputer baru.
- **Disk:** salinan lokal repositori (terkompresi) disimpan di folder data Zotero, kira-kira
  sebesar lampiran Anda.

Tutorial lengkap: [docs/TUTORIAL.id.md](docs/TUTORIAL.id.md).

## License

MIT — see [LICENSE](LICENSE).
