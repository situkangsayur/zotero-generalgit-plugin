#!/usr/bin/env bash
# DEVELOPMENT ONLY. Runs on the machine with Zotero. Two throwaway profiles,
# ~/zgit-conflict/A and ~/zgit-conflict/B, take turns syncing one repository,
# then an empty profile C imports it; each step is a separate headless Zotero
# launch. Reports land in ~/zgit-conflict/out/<step>.json.
#
# ZGIT_REMOTE_URL defaults to a bare repository created in ~/zgit-conflict, so
# no account or credentials are involved. Point it at a real host (an EMPTY
# repository git on this machine can push to) to test that host instead.
# ZGIT_LFS=1 sends the large test attachment through Git LFS; git-lfs must be
# on PATH or in ~/zgit-conflict/bin. For an HTTPS remote that needs a token, set
# ZGIT_TOKEN_FILE and ZGIT_HTTPS_USER, and add X0 to ZGIT_STEPS to check the
# error without the token.
#
# Needs: ~/zgit-conflict/zotero-git-sync.xpi, ~/zgit-conflict/zgit-conflict-test.xpi.
set -euo pipefail
T="$HOME/zgit-conflict"
ZOTERO_APP=/usr/lib/zotero
ZGIT_REMOTE_URL="${ZGIT_REMOTE_URL:-file://$T/remote.git}"
STEPS="${ZGIT_STEPS:-A1 B1 A2 B2 B3 A3 C1}"
TEST_PATH="$T/bin:/usr/local/bin:/usr/bin:/bin"

run_zotero() { # profile step
	local profile="$1" step="$2"
	systemd-run --user --unit="zgit-conflict-$profile" --collect \
		--setenv=MOZ_HEADLESS=1 --setenv=XDG_RUNTIME_DIR=/run/user/1000 \
		--setenv=ZGIT_STEP="$step" --setenv=ZGIT_OUT="$T/out" --setenv=PATH="$TEST_PATH" \
		--setenv=ZGIT_REMOTE_URL="$ZGIT_REMOTE_URL" --setenv=ZGIT_BASE_PATH="${ZGIT_BASE_PATH:-}" --setenv=ZGIT_LFS="${ZGIT_LFS:-0}" \
		--setenv=ZGIT_TOKEN_FILE="${ZGIT_TOKEN_FILE:-}" --setenv=ZGIT_HTTPS_USER="${ZGIT_HTTPS_USER:-}" \
		bash -c "exec $ZOTERO_APP/zotero-bin -app $ZOTERO_APP/app/application.ini -no-remote -profile '$T/$profile/profile' -ZoteroDebugText >> '$T/$profile/debug.log' 2>&1"
}
stop_zotero() {
	systemctl --user stop "zgit-conflict-$1" 2>/dev/null || true
	for i in $(seq 1 30); do systemctl --user is-active --quiet "zgit-conflict-$1" || return 0; sleep 1; done
}

setup_profile() { # A|B
	local p="$T/$1"
	rm -rf "$p"
	mkdir -p "$p/profile/extensions" "$p/data"
	cat > "$p/profile/user.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$p/data");
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
	cp "$T/zotero-git-sync.xpi" "$p/profile/extensions/zotero-git-sync@situkangsayur.github.io.xpi"
	cp "$T/zgit-conflict-test.xpi" "$p/profile/extensions/zgit-conflict-test@situkangsayur.github.io.xpi"
	run_zotero "$1" ""
	for i in $(seq 1 60); do grep -q zgit-conflict-test "$p/profile/extensions.json" 2>/dev/null && break; sleep 1; done
	sleep 5; stop_zotero "$1"
	sed -i 's/"active":false/"active":true/g; s/"userDisabled":true/"userDisabled":false/g; s/"seen":false/"seen":true/g' "$p/profile/extensions.json"
}

if [ "${ZGIT_SETUP:-1}" = 1 ]; then
	rm -rf "$T/out"; mkdir -p "$T/out"
	if [ "$ZGIT_REMOTE_URL" = "file://$T/remote.git" ]; then
		rm -rf "$T/remote.git"
		git init --bare --quiet "$T/remote.git"
	fi
	setup_profile A
	setup_profile B
	setup_profile C
fi

for step in $STEPS; do
	profile="${step:0:1}"; [ "$profile" = X ] && profile=C
	rm -f "$T/out/$step.done"
	run_zotero "$profile" "$step"
	for i in $(seq 1 600); do [ -f "$T/out/$step.done" ] && break; sleep 1; done
	sleep 3; stop_zotero "$profile"
	echo "$step: $(cat "$T/out/$step.done" 2>/dev/null || echo timeout)"
	[ "$(cat "$T/out/$step.done" 2>/dev/null)" = ok ] || exit 1
done
