/* Zotero Git Sync -- preference pane controller
 *
 * Loaded into a sandbox whose prototype is the preferences window. Inline
 * handlers in preferences.xhtml are compiled against the window itself, so the
 * controller is attached to `window` rather than declared with `var`.
 *
 * Fields carrying a `preference` attribute are wired up by Zotero; everything
 * here is for the parts it can't do: the token (which isn't a preference), the
 * connection test and the action buttons.
 */

window.ZoteroGitSyncPrefs = {
	_statusTimer: null,


	get plugin() {
		return Zotero.GitSync;
	},


	async init() {
		this._tokenStatus = document.getElementById('zgit-token-status');
		this._testStatus = document.getElementById('zgit-test-status');
		this._status = document.getElementById('zgit-status');
		this._tokenInput = document.getElementById('zgit-token');

		this._tokenInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				this.saveToken();
			}
		});

		await this.refreshTokenStatus();
		this.refreshStatus();
		this._showDefaultLocalPath();
		// The status block shows the result of syncs started from anywhere, so
		// keep it current while the pane is open
		this._statusTimer = setInterval(() => this.refreshStatus(), 1000);
	},


	uninit() {
		if (this._statusTimer) {
			clearInterval(this._statusTimer);
			this._statusTimer = null;
		}
	},


	// -- Token -------------------------------------------------------------

	async saveToken() {
		let token = this._tokenInput.value.trim();
		if (!token) {
			this._setTokenStatus('Enter a token first.', 'error');
			return;
		}
		try {
			await this.plugin.Prefs.setToken(token);
			// Don't leave the secret sitting in the field
			this._tokenInput.value = '';
			await this.refreshTokenStatus();
			this._setTokenStatus('Token saved. Use "Test connection" to check it.', 'ok');
		}
		catch (e) {
			Zotero.logError(e);
			this._setTokenStatus(`Could not save the token: ${e.message || e}`, 'error');
		}
	},


	async clearToken() {
		try {
			await this.plugin.Prefs.setToken('');
			this._tokenInput.value = '';
			this._setTokenStatus('Token removed.', '');
		}
		catch (e) {
			Zotero.logError(e);
			this._setTokenStatus(`Could not remove the token: ${e.message || e}`, 'error');
		}
	},


	async refreshTokenStatus() {
		let token = await this.plugin.Prefs.getToken();
		this._setTokenStatus(token ? 'A token is saved.' : 'No token saved (not needed for SSH or a credential helper).', '');
	},


	_showDefaultLocalPath() {
		try {
			let config = { ...this.plugin.Prefs.getConfig(), localRepoPath: '' };
			document.getElementById('zgit-local-repo').placeholder = config.remoteURL
				? this.plugin.Prefs.getLocalRepoPath(config)
				: 'next to the Zotero data directory';
		}
		catch (e) {
			Zotero.logError(e);
		}
	},


	async testConnection() {
		let plugin = this.plugin;
		let config = plugin.Prefs.getConfig();
		if (!config.remoteURL) {
			this._setStatus(this._testStatus, 'Enter the repository address first.', 'error');
			return;
		}
		this._showDefaultLocalPath();
		this._setStatus(this._testStatus, 'Checking…', '');
		let lines = [];
		try {
			let gitPath = await plugin.Git.find(config.gitPath);
			let versions = await plugin.Git.versions(gitPath);
			lines.push(`${versions.git} (${gitPath})`);
			lines.push(versions.lfs
				? versions.lfs.split(' ')[0]
				: config.lfsEnabled
					? 'git-lfs is not installed: Git LFS is turned on, so large files will be committed to Git directly instead.'
					: 'git-lfs is not installed (not needed: Git LFS is turned off).');

			let token = await plugin.Prefs.getToken();
			let [major, minor] = (versions.git.match(/(\d+)\.(\d+)/) || []).slice(1).map(Number);
			if (token && (major < 2 || (major === 2 && minor < 31))) {
				lines.push('This git is older than 2.31 and cannot receive the saved token; update git or use a credential helper.');
			}

			let probe = new plugin.Repository({
				gitPath,
				gitDir: null,
				remoteURL: config.remoteURL,
				branch: config.branch,
				httpsUsername: config.httpsUsername,
				token,
			});
			let identity = config.authorName && config.authorEmail
				? `${config.authorName} <${config.authorEmail}>`
				: await probe.identity();
			lines.push(identity ? `Commits by ${identity}` : 'No git identity configured: commits will be by "Zotero Git Sync".');

			let branches = await probe.listRemoteBranches();
			let label = plugin.Prefs.getRepoLabel(config);
			if (!branches.size) {
				lines.unshift(`Connected to ${label}. The repository is empty; the first sync creates branch "${config.branch}".`);
			}
			else if (branches.has(config.branch)) {
				lines.unshift(`Connected to ${label}. Branch "${config.branch}" exists (${branches.size} branch(es) in total).`);
			}
			else {
				lines.unshift(`Connected to ${label}. Branch "${config.branch}" doesn't exist yet; the first sync creates it. `
					+ `Existing branches: ${[...branches.keys()].slice(0, 5).join(', ')}`);
			}
			lines.push('Reading works. Write access is checked by the first sync.');
			this._setStatus(this._testStatus, lines.join('\n'), versions.lfs || !config.lfsEnabled ? 'ok' : '');
		}
		catch (e) {
			Zotero.logError(e);
			this._setStatus(this._testStatus, [e.message || String(e), ...lines].join('\n'), 'error');
		}
	},


	// -- Actions -----------------------------------------------------------

	syncNow() {
		this.plugin.Sync.syncNow({ trigger: 'preferences' })
			.then(() => this.refreshStatus())
			.catch(e => Zotero.logError(e));
	},


	pull() {
		this.plugin.Sync.pull()
			.then(() => this.refreshStatus())
			.catch(e => Zotero.logError(e));
	},


	cancel() {
		this.plugin.Sync.cancel();
		this.refreshStatus();
	},


	openRepo() {
		let url = this.plugin.Prefs.getRepoURL();
		if (url) {
			Zotero.launchURL(url);
		}
	},


	// -- Status ------------------------------------------------------------

	refreshStatus() {
		let prefs = this.plugin.Prefs;
		let lastSync = prefs.get('lastSync');
		let lastCommit = prefs.get('lastCommit');
		let lastError = prefs.get('lastError');
		let lastWarnings = prefs.get('lastWarnings');

		let lines = [];
		let sync = this.plugin.Sync;
		let running = sync.isRunning;
		if (running) {
			lines.push(`Syncing: ${sync.describeProgress() || '…'}`, '');
		}
		document.getElementById('zgit-cancel').hidden = !running;
		document.getElementById('zgit-sync-now').disabled = running;
		document.getElementById('zgit-pull').disabled = running;
		lines.push(lastSync ? `Last sync: ${lastSync}` : 'Never synced.');
		if (lastCommit) {
			lines.push(`Last commit: ${lastCommit.slice(0, 10)}`);
		}
		if (lastError) {
			lines.push(`Last error: ${lastError}`);
		}
		if (lastWarnings) {
			lines.push('Skipped or not restored:', ...lastWarnings.split('\n').map(line => `  ${line}`));
		}

		this._status.textContent = lines.join('\n');
		this._status.classList.toggle('zgit-error', !!lastError);
	},


	_setTokenStatus(message, kind) {
		this._setStatus(this._tokenStatus, message, kind);
	},


	_setStatus(element, message, kind) {
		element.textContent = message;
		element.classList.toggle('zgit-error', kind === 'error');
		element.classList.toggle('zgit-ok', kind === 'ok');
	},
};
