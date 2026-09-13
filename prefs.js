/* Default preferences for Zotero Git Sync.
 *
 * Loaded by Zotero.Plugins on startup. Values here are *default* branch values;
 * anything the user changes is stored on the user branch. An optional HTTPS
 * token is NOT stored here -- it lives in the Firefox login manager (see
 * src/prefs.js). SSH keys and Git credential helpers need nothing from us.
 */

// -- Repository ------------------------------------------------------------
// Anything `git clone` accepts: git@host:owner/repo.git, ssh://..., https://...
pref("extensions.zotero-git-sync.remoteURL", "");
pref("extensions.zotero-git-sync.branch", "main");
pref("extensions.zotero-git-sync.basePath", "zotero");
// HTTPS only, for hosts without a credential helper: the user name sent with
// the token stored in the login manager
pref("extensions.zotero-git-sync.httpsUsername", "");
// Where the local copy of the repository lives. Empty means a folder next to
// the Zotero data directory's storage folder.
pref("extensions.zotero-git-sync.localRepoPath", "");
// Empty means find git on PATH and in the usual install locations
pref("extensions.zotero-git-sync.gitPath", "");
// Browser address of the repository; empty means derive it from the remote URL
pref("extensions.zotero-git-sync.webURL", "");

// -- What gets exported ----------------------------------------------------
pref("extensions.zotero-git-sync.includeGroupLibraries", true);
pref("extensions.zotero-git-sync.exportJSON", true);
pref("extensions.zotero-git-sync.exportMarkdown", true);
pref("extensions.zotero-git-sync.exportBibTeX", false);
pref("extensions.zotero-git-sync.exportIndex", true);
pref("extensions.zotero-git-sync.includeNotes", true);
pref("extensions.zotero-git-sync.includeAttachments", true);
// Linked files live outside the Zotero data directory, but they are still the
// user's documents
pref("extensions.zotero-git-sync.includeLinkedFiles", true);
// 0 means no limit of our own
pref("extensions.zotero-git-sync.maxAttachmentMB", 0);
// Files above the threshold go to Git LFS instead of Git
pref("extensions.zotero-git-sync.lfsEnabled", true);
pref("extensions.zotero-git-sync.lfsThresholdMB", 50);
// Largest file committed to Git itself when it can't go to LFS. GitHub and
// GitLab.com refuse files over 100 MB; a self-hosted server may take more.
pref("extensions.zotero-git-sync.maxGitFileMB", 100);
pref("extensions.zotero-git-sync.prune", true);

// -- Triggers --------------------------------------------------------------
// Periodic sync
pref("extensions.zotero-git-sync.intervalEnabled", false);
pref("extensions.zotero-git-sync.intervalMinutes", 60);
// Sync a while after the library changes
pref("extensions.zotero-git-sync.syncOnChange", false);
pref("extensions.zotero-git-sync.changeDelayMinutes", 5);
// Sync once, shortly after Zotero starts
pref("extensions.zotero-git-sync.syncOnStartup", false);
// Sync to Git whenever Zotero's own sync (the toolbar sync button) finishes
pref("extensions.zotero-git-sync.syncAfterZoteroSync", false);

// -- Commits ---------------------------------------------------------------
pref("extensions.zotero-git-sync.commitMessage", "Zotero sync: {changes} ({date})");
// Empty means git's own user.name / user.email
pref("extensions.zotero-git-sync.authorName", "");
pref("extensions.zotero-git-sync.authorEmail", "");

// -- State (written by the plugin, not meant to be edited) -----------------
pref("extensions.zotero-git-sync.lastSync", "");
pref("extensions.zotero-git-sync.lastCommit", "");
pref("extensions.zotero-git-sync.lastError", "");
pref("extensions.zotero-git-sync.lastWarnings", "");
pref("extensions.zotero-git-sync.pendingReview", 0);
