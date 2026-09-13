/* Zotero Git Sync -- preference access and token storage
 *
 * Ordinary settings live on the `extensions.zotero-git-sync.` branch (see
 * prefs.js in the plugin root for the defaults). Most people authenticate with
 * an SSH key or git's own credential helper, and the plugin stores nothing. The
 * optional HTTPS token for hosts without a helper goes into the login manager,
 * the same place Zotero keeps its own API key, so it isn't sitting in prefs.js
 * in the profile directory in plain text.
 */

ZoteroGitSync.Prefs = {
	LOGIN_ORIGIN: 'chrome://zotero-git-sync',
	LOGIN_REALM: 'Git HTTPS Token',

	_observers: [],
	_tokenCache: null,


	// -- Plain preferences -------------------------------------------------

	get(key) {
		return Zotero.Prefs.get(ZoteroGitSync.PREF_BRANCH + key, true);
	},


	set(key, value) {
		return Zotero.Prefs.set(ZoteroGitSync.PREF_BRANCH + key, value, true);
	},


	clear(key) {
		try {
			Zotero.Prefs.clear(ZoteroGitSync.PREF_BRANCH + key, true);
		}
		catch (e) {
			// Clearing a pref that was never set throws; nothing to do
		}
	},


	/**
	 * @param {String[]} keys
	 * @param {Function} handler - Called with no arguments when any key changes
	 */
	observe(keys, handler) {
		for (let key of keys) {
			this._observers.push(
				Zotero.Prefs.registerObserver(ZoteroGitSync.PREF_BRANCH + key, handler, true)
			);
		}
	},


	unobserveAll() {
		for (let symbol of this._observers) {
			Zotero.Prefs.unregisterObserver(symbol);
		}
		this._observers = [];
	},


	/**
	 * Reserved for renaming preferences in later versions without losing the
	 * user's settings.
	 */
	migrate() {},


	// -- Derived configuration ---------------------------------------------

	/**
	 * @return {Object} Everything the sync engine needs, already normalized
	 */
	getConfig() {
		let mb = (key, fallback, min, max) => Math.min(max, Math.max(min, Number(this.get(key)) || fallback)) * 1024 * 1024;
		return {
			remoteURL: (this.get('remoteURL') || '').trim(),
			branch: (this.get('branch') || 'main').trim(),
			basePath: ZoteroGitSync.Utils.normalizeBasePath(this.get('basePath')),
			httpsUsername: (this.get('httpsUsername') || '').trim(),
			localRepoPath: (this.get('localRepoPath') || '').trim(),
			gitPath: (this.get('gitPath') || '').trim(),
			webURL: (this.get('webURL') || '').trim(),

			includeGroupLibraries: !!this.get('includeGroupLibraries'),
			exportJSON: !!this.get('exportJSON'),
			exportMarkdown: !!this.get('exportMarkdown'),
			exportBibTeX: !!this.get('exportBibTeX'),
			exportIndex: !!this.get('exportIndex'),
			includeNotes: !!this.get('includeNotes'),
			includeAttachments: !!this.get('includeAttachments'),
			includeLinkedFiles: !!this.get('includeLinkedFiles'),
			maxAttachmentBytes: Math.max(0, Number(this.get('maxAttachmentMB')) || 0) * 1024 * 1024,
			lfsEnabled: !!this.get('lfsEnabled'),
			// Git LFS has no size limit of its own, but a threshold above what the
			// host takes in Git would leave files that fit nowhere
			lfsThresholdBytes: mb('lfsThresholdMB', 50, 1, 10240),
			maxGitFileBytes: mb('maxGitFileMB', 100, 1, 102400),
			prune: !!this.get('prune'),

			intervalEnabled: !!this.get('intervalEnabled'),
			intervalMinutes: Math.max(5, Number(this.get('intervalMinutes')) || 60),
			syncOnChange: !!this.get('syncOnChange'),
			changeDelayMinutes: Math.max(1, Number(this.get('changeDelayMinutes')) || 5),
			syncOnStartup: !!this.get('syncOnStartup'),
			syncAfterZoteroSync: !!this.get('syncAfterZoteroSync'),

			commitMessage: this.get('commitMessage') || 'Zotero sync: {changes} ({date})',
			authorName: (this.get('authorName') || '').trim(),
			authorEmail: (this.get('authorEmail') || '').trim(),
		};
	},


	/**
	 * @return {Boolean} Whether there is enough to attempt a sync
	 */
	hasRepoConfig() {
		let config = this.getConfig();
		return !!(config.remoteURL && config.branch);
	},


	/**
	 * @return {Promise<Boolean>}
	 */
	async isConfigured() {
		return this.hasRepoConfig();
	},


	/**
	 * @return {String} A short name for the repository, for messages
	 */
	getRepoLabel(config = this.getConfig()) {
		return ZoteroGitSync.Utils.remoteLabel(config.remoteURL) || config.remoteURL;
	},


	/**
	 * @return {String} Browser URL of the configured repository, or '' when
	 * 		there's no way to tell (a repository on a plain SSH server, say)
	 */
	getRepoURL(config = this.getConfig()) {
		if (config.webURL) {
			return config.webURL;
		}
		return ZoteroGitSync.Utils.remoteWebURL(config.remoteURL);
	},


	/**
	 * @return {String} Absolute path of the local bare repository
	 */
	getLocalRepoPath(config = this.getConfig()) {
		if (config.localRepoPath) {
			return config.localRepoPath;
		}
		return PathUtils.join(Zotero.DataDirectory.dir, 'git-sync', `${ZoteroGitSync.State.id(config)}.git`);
	},


	// -- HTTPS token -------------------------------------------------------

	/**
	 * @return {Promise<String>} The stored token, or '' if there is none
	 */
	async getToken() {
		if (this._tokenCache !== null) {
			return this._tokenCache;
		}
		let login = await this._findLogin();
		this._tokenCache = login ? login.password : '';
		return this._tokenCache;
	},


	/**
	 * @param {String} token - Pass '' to remove the stored token
	 */
	async setToken(token) {
		token = (token || '').trim();
		let existing = await this._findLogin();

		if (!token) {
			if (existing) {
				// The synchronous form: removeLoginAsync() doesn't exist in Zotero 10
				Services.logins.removeLogin(existing);
			}
			this._tokenCache = '';
			return;
		}

		let nsLoginInfo = new Components.Constructor(
			'@mozilla.org/login-manager/loginInfo;1',
			Components.interfaces.nsILoginInfo,
			'init'
		);
		let loginInfo = new nsLoginInfo(
			this.LOGIN_ORIGIN,
			null,
			this.LOGIN_REALM,
			'token',
			token,
			'',
			''
		);
		if (existing) {
			// The synchronous form: modifyLoginAsync() doesn't exist in Zotero 10
			Services.logins.modifyLogin(existing, loginInfo);
		}
		else {
			await Services.logins.addLoginAsync(loginInfo);
		}
		this._tokenCache = token;
	},


	async _findLogin() {
		try {
			let logins = await Services.logins.searchLoginsAsync({
				origin: this.LOGIN_ORIGIN,
				httpRealm: this.LOGIN_REALM,
			});
			return logins.length ? logins[0] : null;
		}
		catch (e) {
			ZoteroGitSync.logError(e);
			return null;
		}
	},
};
