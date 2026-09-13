#!/usr/bin/env bash
# DEVELOPMENT ONLY. Runs on the machine with Zotero. Creates ~/zgit-import-test
# with an empty profile and data directory, installs the plugin and the import
# test addon, and starts a headless Zotero that runs Import from Git and
# writes ~/zgit-import-test/out/{report.json,DONE}. Returns once the import is
# running; poll for DONE. Never touches the real profile.
#
# Needs: ~/zgit-import-test/zotero-git-sync.xpi, ~/zgit-import-test/zgit-import-test.xpi,
# and ZGIT_REMOTE_URL, a repository git on this machine can fetch (SSH key or
# credential helper). git-lfs is looked up on PATH and in ~/zgit-import-test/bin.
set -euo pipefail
T="$HOME/zgit-import-test"
ZOTERO_APP=/usr/lib/zotero
: "${ZGIT_REMOTE_URL:?}"

systemctl --user stop zgit-import-test 2>/dev/null || true
rm -rf "$T/profile" "$T/data" "$T/out"
mkdir -p "$T/profile/extensions" "$T/data" "$T/out"
cat > "$T/profile/user.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$T/data");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.httpServer.enabled", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zotero.sync.reminder.setUp.enabled", false);
user_pref("extensions.zotero.sync.reminder.autoSync.enabled", false);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.integration.autoInstall", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("app.update.enabled", false);
PREFS
cp "$T/zotero-git-sync.xpi" "$T/profile/extensions/zotero-git-sync@situkangsayur.github.io.xpi"
cp "$T/zgit-import-test.xpi" "$T/profile/extensions/zgit-import-test@situkangsayur.github.io.xpi"

start() {
	systemd-run --user --unit=zgit-import-test --collect \
		--setenv=MOZ_HEADLESS=1 --setenv=XDG_RUNTIME_DIR=/run/user/1000 \
		--setenv=ZGIT_IMPORT_TEST_DIR="$1" --setenv=ZGIT_REMOTE_URL="$ZGIT_REMOTE_URL" \
		--setenv=PATH="$T/bin:/usr/local/bin:/usr/bin:/bin" --setenv=SSH_AUTH_SOCK="${SSH_AUTH_SOCK:-}" \
		--setenv=ZGIT_BRANCH="${ZGIT_BRANCH:-main}" --setenv=ZGIT_BASE_PATH="${ZGIT_BASE_PATH:-}" \
		bash -c "exec $ZOTERO_APP/zotero-bin -app $ZOTERO_APP/app/application.ini -no-remote -profile '$T/profile' -ZoteroDebugText > '$T/debug.log' 2>&1"
}
stop() {
	systemctl --user stop zgit-import-test 2>/dev/null || true
	for i in $(seq 1 30); do systemctl --user is-active --quiet zgit-import-test || return 0; sleep 1; done
}

start ""
for i in $(seq 1 60); do grep -q zgit-import-test "$T/profile/extensions.json" 2>/dev/null && break; sleep 1; done
sleep 5; stop
sed -i 's/"active":false/"active":true/g; s/"userDisabled":true/"userDisabled":false/g; s/"seen":false/"seen":true/g' "$T/profile/extensions.json"
start "$T/out"
echo "import test started"
