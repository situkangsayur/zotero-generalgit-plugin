# Tutorial: back up your Zotero library to any Git host

This guide installs Zotero Git Sync, connects it to a repository on GitLab, Gitea, Forgejo,
Codeberg, Bitbucket or your own server, and runs the first sync. About fifteen minutes, plus
the time your PDFs take to upload.

*Bahasa Indonesia: [TUTORIAL.id.md](TUTORIAL.id.md)*

---

## 1. Install git (and git-lfs)

The plugin runs the `git` program on your computer.

| System | Install |
| --- | --- |
| Windows | [Git for Windows](https://git-scm.com/download/win) — includes Git LFS |
| macOS | `brew install git git-lfs`, or `xcode-select --install` for git alone |
| Debian/Ubuntu | `sudo apt install git git-lfs` |
| Fedora | `sudo dnf install git git-lfs` |
| Arch | `sudo pacman -S git git-lfs` |

Git LFS is for attachments over 50 MB. If you don't install it, turn off *Store files larger
than … with Git LFS* in step 5.

Restart Zotero after installing git, so it sees the new program.

## 2. Create the repository

On your Git host, create a new **empty** repository for the library, for example
`zotero-library`. Make it **private** unless you want your library public. Don't add a
README; an empty repository is simplest.

If your attachments are large, check that **LFS** is enabled for the repository (it is by
default on GitLab, Gitea/Forgejo and Bitbucket) and look up the host's storage limits.

## 3. Let git sign in without asking

The plugin can't answer password prompts, so git must reach the repository on its own.
Choose one:

### Option A: SSH key (recommended)

1. If you don't have a key: `ssh-keygen -t ed25519` (press Enter to accept the defaults).
2. Add the **public** key (`~/.ssh/id_ed25519.pub`) to your account on the host:
   - GitLab: *Preferences → SSH Keys*
   - Gitea / Forgejo / Codeberg: *Settings → SSH / GPG Keys*
   - Bitbucket: *Personal settings → SSH keys*
   - Your own server: append it to `~/.ssh/authorized_keys` of the git user
3. If the key has a passphrase, load it into your SSH agent (`ssh-add`), which most desktops
   do at login.
4. Connect once from a terminal and answer **yes** to the host key question:

   ```sh
   ssh -T git@gitlab.com
   ```

### Option B: HTTPS with a credential helper

If you already push over HTTPS from a terminal without typing a password, git has a
credential helper and nothing more is needed.

### Option C: HTTPS with an access token in the plugin

Create an access token on the host with permission to read and write repositories:

| Host | Where | User name to enter |
| --- | --- | --- |
| GitLab | *Preferences → Access tokens*, scopes `read_repository`, `write_repository` | your GitLab user name |
| Gitea / Forgejo / Codeberg | *Settings → Applications → Generate token*, repository: read and write | your user name |
| Bitbucket | Repository *Settings → Access tokens* (read + write) | `x-token-auth` |

You'll paste it into the plugin in step 5.

### Check

```sh
git ls-remote <repository address>
```

Nothing printed and no error means it works (an empty repository has no branches). A prompt
means the plugin would get stuck at the same point — go back to option A, B or C.

## 4. Install the plugin

1. Download `zotero-git-sync-<version>.xpi` from the
   [releases page](https://github.com/situkangsayur/zotero-generalgit-plugin/releases/latest).
   In Firefox, right-click the link and choose *Save Link As…*.
2. In Zotero: **Tools → Plugins**, the gear icon, **Install Plugin From File…**, pick the file.

A Git Sync button appears at the top right of the main window, next to Zotero's sync button.

## 5. Connect it to the repository

Open **Edit → Settings → Git Sync** (macOS: **Zotero → Settings**).

### Repository

| Field | What to enter |
| --- | --- |
| Repository address | The clone address, e.g. `git@gitlab.com:you/zotero-library.git` |
| Branch | `main` |
| Folder inside the repository | `zotero` (the default), or empty for the repository root |

Click **Test connection**. A good result says *Connected to …*, shows the git and git-lfs
versions, and who commits will be attributed to.

### HTTPS sign-in (option C only)

Enter the user name, paste the token, click **Save token**, then **Test connection** again.

### What gets synced

Everything is on by default: item metadata, Markdown notes, child notes, group libraries,
attachment files and linked files. Files over 50 MB go to Git LFS. Git keeps every version of
every file, so replacing PDFs grows the repository over time.

### Commits

Leave the author fields empty to use your git identity (`git config --global user.name`).

### When to sync

| Option | Syncs |
| --- | --- |
| *Sync every … minutes* | On a schedule |
| *Sync after the library changes* | A few minutes after you stop editing |
| *Sync shortly after Zotero starts* | One minute after Zotero opens |
| *Sync to Git after Zotero's own sync finishes* | Each time Zotero syncs |

A sync that finds nothing to change makes no commit.

## 6. Run the first sync

Click the **Git Sync button** in the toolbar, or **Sync now** in the settings. The icon spins
and shows a percentage; click it for the progress window.

On a first sync:

1. **Checking attachment files.** Each file is hashed once; later syncs reuse the result.
2. **Large files to Git LFS.**
3. **Metadata and notes** are stored and pushed first.
4. **Attachment files** follow in checkpoints — a commit pushed every 100 MB or 1,000 files.
   If the sync is cancelled, fails or Zotero closes, every pushed checkpoint stays, and the
   next sync carries on from there.
5. **A final commit** with the list of files the plugin manages.

To stop: right-click the button → **Cancel Git Sync**.

Afterwards the repository holds your library:

- `zotero/my-library/items/` — one JSON file per item, with notes, attachments and annotations
- `zotero/my-library/notes/` — a Markdown page per item (opens in Obsidian)
- `zotero/my-library/attachments/` and `attachments-lfs/` — the files
- `zotero/my-library/index.md` — a table of contents by collection

The plugin also keeps a compressed local copy of the repository in the `git-sync` folder of
your Zotero data directory. It takes roughly as much space as your attachments.

## 7. If something goes wrong

The button turns red. Hover over it for the message, or look at **Status** in the settings.

| Message | Fix |
| --- | --- |
| *git was not found* | Install git and restart Zotero, or set *git program* under Advanced |
| *SSH does not know this server yet* | `ssh -T git@<host>` once in a terminal, answer yes |
| *The server did not accept an SSH key* | Add the public key on the host; `ssh-add` a key with a passphrase |
| *The server refused the HTTPS credentials* | Check the user name and token, or set up a credential helper |
| *The repository was not found* | Check the address; create the repository first |
| *… stopped responding* | git waited for a prompt: use option A, B or C from step 3 |
| *Git LFS is not installed* | Install git-lfs, or turn off Git LFS |
| *refused the push because of a size limit or quota* | Lower the LFS threshold, skip very large files, check the host's limits |

Turn on **Help → Debug Output Logging** before syncing for more detail; plugin lines start
with `[Git Sync]` and list every git command.

## 8. Syncing from more than one computer

Each computer remembers what it last synced, so the plugin can tell your changes from changes
made elsewhere. When a sync finds something that needs a decision, a review panel opens
inside the Zotero window:

| Section | Meaning | Your choice |
| --- | --- | --- |
| **Changes in the repository** | Changed or added elsewhere, unchanged here | Tick to import into Zotero; unticked ones are asked again next time |
| **Changed in both places** | Changed here *and* elsewhere | Keep Zotero's version, take the repository's, or — for files — keep both |
| **Deleted in the repository, still in Zotero** | Another computer deleted it | Tick to upload it again; to accept the deletion, delete the item in Zotero |
| **Edited in the repository, generated by the plugin** | Someone edited a Markdown note or index | These are regenerated; untick to leave them alone this time |
| **Files this sync replaces or deletes** | Your own changes | Untick to exclude a file from this sync |

Background syncs never wait for you: they push what is safe and leave the rest, and the
button shows an orange dot. Click it, or use **Tools → Git Sync → Review Changes and Sync…**.

## 9. Restore on another computer

1. Install git, Zotero and the plugin; set up sign-in (step 3) and the same repository
   address.
2. **Tools → Git Sync → Import from Git…**

Import adds missing items (with the same keys, so annotations find their PDFs), updates items
whose repository copy is newer, recreates collections, saved searches and tag colors, and
restores attachment files into Zotero's storage folder. It never deletes anything.

To get the files with plain Git, clone the repository with git-lfs installed.

## Good to know

- **Zotero stays the source of truth.** Changes in the repository reach your library only
  when you accept them in a review, and a sync never deletes anything from your library.
- **The same repository works with Zotero GitHub Sync** if it lives on GitHub; the two
  plugins write the same format.
- **Moving hosts** is a `git push --mirror` away: point the plugin at the new address and
  keep syncing. (Copy LFS objects too, with `git lfs fetch --all` and `git lfs push --all`.)
