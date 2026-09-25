#!/usr/bin/env bash
# DEVELOPMENT ONLY. Runs on the machine with Zotero. Checks the three fixes in
# 0.1.4 against a throwaway bare repository in ~/zgit-fixes: the prune
# preference, "keep both" for a multi-file attachment, and a repository path
# that tries to leave the attachment folder. Three throwaway profiles take
# turns; each step is a separate headless Zotero launch and writes
# ~/zgit-fixes/out/<step>.json.
#
# Needs: ~/zgit-fixes/zotero-git-sync.xpi, ~/zgit-fixes/zgit-fixes-test.xpi.
set -euo pipefail
T="$HOME/zgit-fixes"
ZOTERO_APP=/usr/lib/zotero
REMOTE="$T/remote.git"
ZGIT_REMOTE_URL="file://$REMOTE"
STEPS="${ZGIT_STEPS:-F1 F2 F3 F4 F5 F6 EVIL F7}"
TEST_PATH="$T/bin:/usr/local/bin:/usr/bin:/bin"

profile_for() { # step -> profile
	case "$1" in
		F4|F6) echo B ;;
		F7) echo C ;;
		*) echo A ;;
	esac
}

run_zotero() { # profile step
	local profile="$1" step="$2"
	systemd-run --user --unit="zgit-fixes-$profile" --collect \
		--setenv=MOZ_HEADLESS=1 --setenv=XDG_RUNTIME_DIR=/run/user/1000 \
		--setenv=ZGIT_STEP="$step" --setenv=ZGIT_OUT="$T/out" --setenv=PATH="$TEST_PATH" \
		--setenv=ZGIT_REMOTE_URL="$ZGIT_REMOTE_URL" \
		bash -c "exec $ZOTERO_APP/zotero-bin -app $ZOTERO_APP/app/application.ini -no-remote -profile '$T/$profile/profile' -ZoteroDebugText >> '$T/$profile/debug.log' 2>&1"
}
stop_zotero() {
	systemctl --user stop "zgit-fixes-$1" 2>/dev/null || true
	for i in $(seq 1 30); do systemctl --user is-active --quiet "zgit-fixes-$1" || return 0; sleep 1; done
}

setup_profile() { # A|B|C
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
	cp "$T/zgit-fixes-test.xpi" "$p/profile/extensions/zgit-fixes-test@situkangsayur.github.io.xpi"
	run_zotero "$1" ""
	for i in $(seq 1 60); do grep -q zgit-fixes-test "$p/profile/extensions.json" 2>/dev/null && break; sleep 1; done
	sleep 5; stop_zotero "$1"
	sed -i 's/"active":false/"active":true/g; s/"userDisabled":true/"userDisabled":false/g; s/"seen":false/"seen":true/g' "$p/profile/extensions.json"
}

# Put `<attachment dir>/../escape.txt` into the branch. Git will not build such
# a path from a worktree, but a tree entry named `..` is just bytes, so a
# malicious or broken server can serve one; the plugin has to refuse it.
graft_escape() {
	local G="git --git-dir=$REMOTE"
	local head dir blob escape_tree entries child parent tree
	head=$($G rev-parse refs/heads/main)
	dir=$($G ls-tree -r --name-only "$head" | grep '/attachments/' | head -1 | sed 's#/[^/]*$##')
	[ -n "$dir" ] || { echo "no attachment directory in the branch"; return 1; }
	blob=$(printf 'escaped\n' | $G hash-object -w --stdin)
	escape_tree=$(printf '100644 blob %s\tescape.txt\n' "$blob" | $G mktree)
	tree=$( { $G ls-tree "$head:$dir"; printf '040000 tree %s\t..\n' "$escape_tree"; } | $G mktree )
	while [ "$dir" != "." ]; do
		child=$(basename "$dir"); parent=$(dirname "$dir")
		if [ "$parent" = "." ]; then entries=$($G ls-tree "$head"); else entries=$($G ls-tree "$head:$parent"); fi
		tree=$( { printf '%s\n' "$entries" | grep -v "	$child\$"; printf '040000 tree %s\t%s\n' "$tree" "$child"; } | $G mktree )
		dir="$parent"
	done
	local commit
	commit=$($G -c user.email=evil@example.invalid -c user.name=Evil commit-tree "$tree" -p "$head" -m 'a path that leaves the attachment folder')
	$G update-ref refs/heads/main "$commit"
	echo "grafted: $($G ls-tree -r --name-only "$commit" | grep '\.\.' || true)"
}

if [ "${ZGIT_SETUP:-1}" = 1 ]; then
	rm -rf "$T/out"; mkdir -p "$T/out"
	rm -rf "$REMOTE"
	git init --bare --quiet "$REMOTE"
	git --git-dir="$REMOTE" symbolic-ref HEAD refs/heads/main
	setup_profile A
	setup_profile B
	setup_profile C
fi

for step in $STEPS; do
	if [ "$step" = EVIL ]; then
		graft_escape
		echo "EVIL: ok"
		continue
	fi
	profile=$(profile_for "$step")
	rm -f "$T/out/$step.done"
	run_zotero "$profile" "$step"
	for i in $(seq 1 600); do [ -f "$T/out/$step.done" ] && break; sleep 1; done
	sleep 3; stop_zotero "$profile"
	echo "$step: $(cat "$T/out/$step.done" 2>/dev/null || echo timeout)"
	[ "$(cat "$T/out/$step.done" 2>/dev/null)" = ok ] || { sed -n 's/.*"error": *"\(.*\)/\1/p' "$T/out/$step.json" 2>/dev/null | head -3; exit 1; }
done
echo "all fixes-test steps passed"
