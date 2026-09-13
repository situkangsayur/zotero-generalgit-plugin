/* Zotero Git Sync -- orchestration and scheduling
 *
 * One sync is: export the library to files, fetch the branch, compare Git blob
 * hashes three ways (see planner.js), then store only what changed in the
 * local repository and push it.
 *
 * Text files (item JSON, Markdown, LFS pointers) are stored with one git
 * process and go up in the first push. Attachment files follow in checkpoints:
 * each checkpoint is a commit pushed on its own, so a first sync of a large
 * library that is cancelled or fails keeps everything already pushed, and the
 * next sync carries on from there.
 *
 * Deletions are driven by `.zotero-sync/files.json`, a sorted list of the paths
 * this plugin wrote last time. Pruning only ever touches paths on that list, so
 * pointing the plugin at a repository root can never delete files that belong to
 * something else. The list and the deletions land in the final commit only.
 */

ZoteroGitSync.Sync = {
	FILE_LIST_PATH: '.zotero-sync/files.json',
	STARTUP_DELAY_MS: 60 * 1000,

	// Attachment files handed to one `git hash-object` process
	STORE_BATCH_FILES: 200,
	STORE_BATCH_BYTES: 64 * 1024 * 1024,
	// Push a checkpoint once this much is waiting
	CHECKPOINT_BYTES: 100 * 1024 * 1024,
	CHECKPOINT_FILES: 1000,

	status: 'idle',
	lastResult: null,
	pendingReview: 0,
	_pendingNotified: false,
	progress: null,

	_running: false,
	_cancel: null,
	_intervalTimer: null,
	_changeTimer: null,
	_startupTimer: null,
	_notifierID: null,
	_zoteroSyncNotifierID: null,
	_suppressChangeTrigger: false,
	_progressWindow: null,


	// -- Lifecycle ---------------------------------------------------------

	init() {
		this.pendingReview = Number(ZoteroGitSync.Prefs.get('pendingReview')) || 0;
		if (this.pendingReview) {
			this.status = 'attention';
		}
		ZoteroGitSync.Prefs.observe(
			['intervalEnabled', 'intervalMinutes', 'syncOnChange', 'changeDelayMinutes'],
			() => this.updateSchedule()
		);
		this.updateSchedule();

		// Zotero announces the end of its own sync; follow it with ours if asked
		this._zoteroSyncNotifierID = Zotero.Notifier.registerObserver(
			{
				notify: (event, type) => {
					if (type !== 'sync' || event !== 'finish') {
						return;
					}
					if (!ZoteroGitSync.Prefs.getConfig().syncAfterZoteroSync || this._running) {
						return;
					}
					this.syncNow({ trigger: 'zotero-sync', silent: true }).catch(e => ZoteroGitSync.logError(e));
				},
			},
			['sync'],
			'zotero-git-sync-after-zotero-sync'
		);

		if (ZoteroGitSync.Prefs.getConfig().syncOnStartup) {
			this._startupTimer = setTimeout(() => {
				this._startupTimer = null;
				this.syncNow({ trigger: 'startup', silent: true }).catch(e => ZoteroGitSync.logError(e));
			}, this.STARTUP_DELAY_MS);
		}
	},


	shutdown() {
		ZoteroGitSync.Review?.close();
		this.cancel();
		this._clearTimer('_intervalTimer', true);
		this._clearTimer('_changeTimer');
		this._clearTimer('_startupTimer');
		for (let name of ['_notifierID', '_zoteroSyncNotifierID']) {
			if (this[name]) {
				Zotero.Notifier.unregisterObserver(this[name]);
				this[name] = null;
			}
		}
		this._progressWindow?.close();
		this._progressWindow = null;
		ZoteroGitSync.Prefs.unobserveAll();
	},


	_clearTimer(name, isInterval = false) {
		if (this[name]) {
			(isInterval ? clearInterval : clearTimeout)(this[name]);
			this[name] = null;
		}
	},


	/**
	 * Bring the periodic timer and the change observer in line with the prefs.
	 * Called on startup and whenever one of those prefs changes.
	 */
	updateSchedule() {
		let config = ZoteroGitSync.Prefs.getConfig();

		this._clearTimer('_intervalTimer', true);
		if (config.intervalEnabled) {
			let ms = config.intervalMinutes * 60 * 1000;
			this._intervalTimer = setInterval(() => {
				this.syncNow({ trigger: 'interval', silent: true }).catch(e => ZoteroGitSync.logError(e));
			}, ms);
			ZoteroGitSync.log(`Periodic sync every ${config.intervalMinutes} minute(s)`);
		}

		if (config.syncOnChange && !this._notifierID) {
			this._notifierID = Zotero.Notifier.registerObserver(
				{ notify: (...args) => this._onNotify(...args) },
				['item', 'collection', 'collection-item', 'item-tag', 'search', 'setting'],
				'zotero-git-sync'
			);
			ZoteroGitSync.log('Watching the library for changes');
		}
		else if (!config.syncOnChange && this._notifierID) {
			Zotero.Notifier.unregisterObserver(this._notifierID);
			this._notifierID = null;
			this._clearTimer('_changeTimer');
		}
	},


	_onNotify(event, type, ids, _extraData) {
		if (this._suppressChangeTrigger || this._running) {
			return;
		}
		if (!['add', 'modify', 'delete', 'trash', 'remove'].includes(event) || !ids?.length) {
			return;
		}
		let config = ZoteroGitSync.Prefs.getConfig();
		if (!config.syncOnChange) {
			return;
		}
		// Editing an item fires a stream of notifications; wait until the user
		// has been quiet for a while rather than syncing after every keystroke
		this._clearTimer('_changeTimer');
		this._changeTimer = setTimeout(() => {
			this._changeTimer = null;
			this.syncNow({ trigger: 'change', silent: true }).catch(e => ZoteroGitSync.logError(e));
		}, config.changeDelayMinutes * 60 * 1000);
	},


	// -- Status and progress -----------------------------------------------

	get isRunning() {
		return this._running;
	},


	_setStatus(status) {
		this.status = status;
		this._notifyUI();
	},


	/**
	 * @param {Object} update - Merged into `this.progress`: {
	 * 		phase: collecting | fetching | hashing | uploading-lfs | uploading | committing | importing,
	 * 		done, total (files), bytesDone, bytesTotal, pushing
	 * 	}
	 */
	_updateProgress(update) {
		this.progress = { ...(this.progress || {}), pushing: false, ...update };
		this._notifyUI();
	},


	_notifyUI() {
		try {
			ZoteroGitSync.UI.onStatusChange(this.status, this.progress);
		}
		catch (e) {
			ZoteroGitSync.logError(e);
		}
		this._renderProgressWindow();
	},


	/**
	 * @return {Number|null} 0-100, or null while there's nothing to measure yet
	 */
	percent(progress = this.progress) {
		if (!progress) {
			return null;
		}
		if (progress.bytesTotal) {
			return Math.min(100, Math.floor((progress.bytesDone / progress.bytesTotal) * 100));
		}
		if (progress.total) {
			return Math.min(100, Math.floor((progress.done / progress.total) * 100));
		}
		return null;
	},


	/**
	 * @return {String} One line describing what the sync is doing right now
	 */
	describeProgress(progress = this.progress) {
		if (!progress) {
			return '';
		}
		let Utils = ZoteroGitSync.Utils;
		let get = (key, ...args) => ZoteroGitSync.getString(key, ...args);
		let line;
		switch (progress.phase) {
			case 'hashing':
				line = get('progress.hashing', String(progress.done || 0), String(progress.total || 0));
				break;
			case 'uploading-lfs':
				line = get('progress.uploadingLFSCount', String(progress.done || 0), String(progress.total || 0));
				break;
			case 'fetching':
				line = progress.message || get('progress.fetching', '');
				if (progress.total) {
					line += ` (${progress.done}/${progress.total})`;
				}
				break;
			case 'uploading':
				line = get(
					progress.pushing ? 'progress.pushingCount' : 'progress.uploadingCount',
					String(progress.done || 0),
					String(progress.total || 0),
					Utils.formatSize(progress.bytesDone || 0),
					Utils.formatSize(progress.bytesTotal || 0)
				);
				break;
			case 'committing':
				line = get('progress.committing');
				break;
			case 'importing':
				line = progress.message || get('progress.importing');
				break;
			default:
				line = progress.message || get('progress.collecting');
		}
		let percent = this.percent(progress);
		if (percent !== null && ['uploading', 'uploading-lfs', 'hashing'].includes(progress.phase)) {
			line += ` — ${percent}%`;
		}
		return line;
	},


	/**
	 * Stop the running sync at the next safe point. Files already committed stay
	 * committed.
	 */
	cancel() {
		if (this._cancel && !this._cancel.cancelled) {
			ZoteroGitSync.log('Cancelling sync');
			this._cancel.cancel();
			this._updateProgress({ message: ZoteroGitSync.getString('progress.cancelling') });
		}
	},


	// -- Sync --------------------------------------------------------------

	/**
	 * @param {Object} [options]
	 * @param {String} [options.trigger='manual'] - manual | button | interval | change | startup | zotero-sync
	 * @param {Zotero.Item[]} [options.items] - Sync only these items
	 * @param {Boolean} [options.silent] - Don't open a progress window
	 * @return {Promise<Object>} { status, added, updated, deleted, commit, warnings }
	 */
	async syncNow({ trigger = 'manual', items = null, silent = false, forceReview = false } = {}) {
		if (this._running) {
			if (!silent) {
				// Already visible on the toolbar button; reopen the window rather
				// than raising an alert
				this._openProgressWindow();
			}
			return { status: 'busy' };
		}

		let config = ZoteroGitSync.Prefs.getConfig();
		let token = await ZoteroGitSync.Prefs.getToken();
		if (!config.remoteURL) {
			if (!silent) {
				this._notify(ZoteroGitSync.getString('error.notConfigured'), { error: true });
			}
			return { status: 'not-configured' };
		}
		if (items && !items.length) {
			if (!silent) {
				this._notify(ZoteroGitSync.getString('error.noItems'), { error: true });
			}
			return { status: 'no-items' };
		}

		this._running = true;
		this._cancel = new ZoteroGitSync.CancelToken();
		this.progress = null;
		this._setStatus('syncing');
		this._updateProgress({ phase: 'collecting' });
		if (!silent) {
			this._openProgressWindow();
		}

		try {
			let result = await this._runSyncWithRetry({ config, token, items, trigger, silent, forceReview });
			ZoteroGitSync.Prefs.set('lastSync', ZoteroGitSync.Utils.isoDate());
			ZoteroGitSync.Prefs.set('lastError', '');
			ZoteroGitSync.Prefs.set('lastWarnings', this._formatWarnings(result.warnings));
			if (result.warnings?.length) {
				result.warnings.forEach(w => ZoteroGitSync.warn(w));
			}
			if (result.commit) {
				ZoteroGitSync.Prefs.set('lastCommit', result.commit);
			}
			this.lastResult = result;
			this.progress = null;
			this.pendingReview = result.pending || 0;
			ZoteroGitSync.Prefs.set('pendingReview', this.pendingReview);
			this._setStatus(this.pendingReview ? 'attention' : 'idle');

			let summary = result.status === 'up-to-date'
				? ZoteroGitSync.getString('progress.upToDate')
				: ZoteroGitSync.getString(
					'progress.done',
					String(result.added + result.updated + result.deleted),
					ZoteroGitSync.Prefs.getRepoLabel(config)
				);
			if (result.pending) {
				summary += `\n${ZoteroGitSync.getString('review.pendingSummary', String(result.pending))}`;
			}
			else if (result.warnings?.length) {
				summary += `\n${ZoteroGitSync.getString('progress.warnings', String(result.warnings.length))}`;
			}
			if (silent && result.pending && !this._pendingNotified) {
				// Say it once, not after every background sync
				this._pendingNotified = true;
				this._notify(ZoteroGitSync.getString('review.pendingSummary', String(result.pending)));
			}
			if (!result.pending) {
				this._pendingNotified = false;
			}
			this._finishProgressWindow(summary);
			return result;
		}
		catch (e) {
			this.progress = null;
			if (e instanceof ZoteroGitSync.CancelledError) {
				ZoteroGitSync.log('Sync cancelled');
				this._setStatus('idle');
				this._finishProgressWindow(ZoteroGitSync.getString('progress.cancelled'));
				return { status: 'cancelled' };
			}
			ZoteroGitSync.logError(e);
			ZoteroGitSync.Prefs.set('lastError', e.message || String(e));
			this._setStatus('error');
			this._progressWindow?.close();
			this._progressWindow = null;
			// Never a modal alert: a dialog the window manager draws badly can
			// lock the whole application. The toolbar button turns red too.
			this._notify(e.message || String(e), { error: true });
			return { status: 'error', error: e.message || String(e) };
		}
		finally {
			this._running = false;
			this._cancel = null;
		}
	},


	/**
	 * If the branch moved while we were building a commit -- another machine
	 * synced, or someone pushed -- the server refuses the non-fast-forward push.
	 * Redoing the sync against the new head is the correct response, and it is
	 * cheap: everything already pushed is skipped.
	 */
	async _runSyncWithRetry(options) {
		try {
			return await this._runSync(options);
		}
		catch (e) {
			if (!e.branchMoved) {
				throw e;
			}
			ZoteroGitSync.log('Branch moved during sync; retrying against the new head');
			return this._runSync(options);
		}
	},


	/**
	 * Find git and open (creating if needed) the local repository.
	 *
	 * @param {Object} config
	 * @param {Object} [options]
	 * @param {String} [options.token] - Defaults to the stored HTTPS token, if any
	 * @return {Promise<ZoteroGitSync.Repository>}
	 */
	async openRepository(config, { token = null, cancel = null } = {}) {
		let gitPath = await ZoteroGitSync.Git.find(config.gitPath);
		if (token === null) {
			token = await ZoteroGitSync.Prefs.getToken();
		}
		let repo = new ZoteroGitSync.Repository({
			gitPath,
			gitDir: ZoteroGitSync.Prefs.getLocalRepoPath(config),
			remoteURL: config.remoteURL,
			branch: config.branch,
			httpsUsername: config.httpsUsername,
			token,
			author: config.authorName && config.authorEmail ? { name: config.authorName, email: config.authorEmail } : null,
			cancel,
		});
		await repo.init();
		return repo;
	},


	async _runSync({ config, token, items, trigger, silent = false, forceReview = false, preset = null, carriedWarnings = [] }) {
		let prefix = config.basePath ? `${config.basePath}/` : '';
		let Files = ZoteroGitSync.Files;
		let Utils = ZoteroGitSync.Utils;
		let Planner = ZoteroGitSync.Planner;
		let cancel = this._cancel;
		let get = (key, ...args) => ZoteroGitSync.getString(key, ...args);

		// -- 1. Analyse: export, fetch the branch, compare three ways -----------

		let repo = await this.openRepository(config, { token, cancel });
		let lfsWarning = null;
		if (config.lfsEnabled && !await repo.lfsAvailable()) {
			// Asked for LFS, but git-lfs isn't installed here: sync without it
			// rather than not at all
			config = { ...config, lfsEnabled: false };
			lfsWarning = get('warning.lfsMissing', ZoteroGitSync.Utils.formatSize(config.maxGitFileBytes));
			ZoteroGitSync.warn(lfsWarning);
		}

		let { files, keepPrefixes, warnings } = await ZoteroGitSync.Exporter.build({
			config,
			items,
			onProgress: message => this._updateProgress({ phase: 'collecting', message }),
		});
		if (lfsWarning) {
			warnings.unshift(lfsWarning);
		}
		// The first pass of a sync that imported changes, and what the import reported
		warnings.unshift(...carriedWarnings);
		cancel.throwIfCancelled();

		this._updateProgress({ phase: 'fetching', message: get('progress.fetching', ZoteroGitSync.Prefs.getRepoLabel(config)) });
		let head = await repo.fetch({ onProgress: p => this._updateProgress({ phase: 'fetching', done: p.done, total: p.total }) });
		this._updateProgress({ phase: 'collecting', message: get('progress.comparing'), done: 0, total: 0 });
		let remoteFiles = head ? await repo.listTree(head) : new Map();
		let remote = new Map();
		for (let [fullPath, entry] of remoteFiles) {
			if (fullPath.startsWith(prefix)) {
				remote.set(fullPath.slice(prefix.length), entry.sha);
			}
		}

		// Attachments whose files exist in the library but not on this computer:
		// whatever an earlier sync committed for them stays, untouched
		let kept = new Set();
		if (keepPrefixes.length) {
			for (let relPath of remote.keys()) {
				if (!files.has(relPath) && keepPrefixes.some(p => relPath.startsWith(p))) {
					kept.add(relPath);
				}
			}
		}

		let isFullSync = !items;
		let previousManaged = isFullSync ? await this._readPreviousFileList(repo, remoteFiles, prefix) : [];
		if (isFullSync) {
			let managed = [...new Set([...files.keys(), ...kept])].sort();
			files.set(this.FILE_LIST_PATH, {
				bytes: Utils.encode(ZoteroGitSync.Exporter.stableStringify(managed) + '\n'),
			});
		}

		// Hash what the export produced. Attachment files come from the hash
		// cache when their size and modification time haven't moved.
		let local = new Map();
		let uploads = new Map();
		let sourceCount = [...files.values()].filter(f => f.source).length;
		let hashed = 0;
		this._updateProgress({ phase: 'hashing', done: 0, total: sourceCount, bytesDone: 0, bytesTotal: 0 });
		await Files.loadCache();
		try {
			for (let [relPath, file] of files) {
				let upload = { fullPath: prefix + relPath, relPath };
				if (file.source) {
					cancel.throwIfCancelled();
					if (file.lfs) {
						let oid = await Files.cachedHash(file.source, 'lfs');
						upload.bytes = Utils.encode(Utils.lfsPointer(oid, file.source.size));
						upload.lfs = { oid, size: file.source.size, path: file.source.path };
						upload.sha = await Utils.gitBlobSha(upload.bytes);
					}
					else {
						upload.sha = await Files.cachedHash(file.source, 'git');
						upload.source = file.source;
					}
					hashed++;
					if (hashed % 10 === 0 || hashed === sourceCount) {
						this._updateProgress({ phase: 'hashing', done: hashed, total: sourceCount });
					}
				}
				else {
					upload.bytes = file.bytes;
					upload.sha = await Utils.gitBlobSha(file.bytes);
				}
				local.set(relPath, upload.sha);
				uploads.set(relPath, upload);
			}
			if (isFullSync) {
				Files.retainCache(new Set(
					[...files.values()].filter(f => f.source).map(f => f.source.path)
				));
			}
		}
		finally {
			await Files.saveCache();
		}

		let state = await ZoteroGitSync.State.load(config);
		let base = state?.base || null;
		let managed = previousManaged.length ? new Set([...previousManaged, this.FILE_LIST_PATH]) : null;
		let plan = Planner.plan({ local, remote, base, kept, fullSync: isFullSync, managed });
		await this._resolveDiverged({ plan, repo, remoteFiles, prefix, uploads });

		// -- 2. Decide ---------------------------------------------------------

		let decisions = preset;
		let pending = 0;
		if (!decisions) {
			let needsReview = Planner.needsReview(plan);
			if (needsReview && silent) {
				// Nobody is watching: do what is safe, leave the rest for a review
				decisions = this._emptyDecisions();
			}
			else if (needsReview || forceReview) {
				this._updateProgress({ phase: 'collecting', message: get('review.preparing') });
				let review = await this._prepareReview({ plan, repo, remoteFiles, prefix, uploads, remote, config });
				decisions = await ZoteroGitSync.Review.ask(review);
				if (!decisions) {
					throw new ZoteroGitSync.CancelledError();
				}
			}
			else {
				decisions = this._emptyDecisions();
			}

			// Accepted changes from the repository go into Zotero first; the
			// library then exports again, carrying the same decisions
			if (decisions.importPaths.size) {
				this._updateProgress({ phase: 'importing', message: get('review.importing', String(decisions.importPaths.size)) });
				this._suppressChangeTrigger = true;
				try {
					let result = await ZoteroGitSync.Importer.applyIncoming({
						repo,
						config,
						remoteFiles,
						relPaths: decisions.importPaths,
						keepBoth: decisions.keepBoth,
						cancel,
						onProgress: message => this._updateProgress({ phase: 'importing', message }),
					});
					warnings.push(...result.failures);
				}
				finally {
					this._suppressChangeTrigger = false;
				}
				return this._runSync({ config, token, items, trigger, silent, preset: decisions, carriedWarnings: warnings });
			}
		}

		// -- 3. Act ------------------------------------------------------------

		let push = new Set(plan.push);
		for (let path of [...plan.conflicts, ...plan.overwrite, ...plan.restore, ...plan.diverged, ...plan.incoming]) {
			// Chosen in the review, or already imported and still different
			// (the export writes it slightly differently): Zotero's copy wins
			if (decisions.pushPaths.has(path) || decisions.importPaths.has(path)) {
				push.add(path);
			}
		}
		let deletions = plan.delete.filter(path => !decisions.excluded.has(path));
		for (let path of decisions.excluded) {
			push.delete(path);
		}
		for (let path of [...push]) {
			if (!uploads.has(path)) {
				push.delete(path);
			}
		}
		let undecided = new Set(decisions.excluded);
		for (let path of [...plan.incoming, ...plan.conflicts, ...plan.overwrite, ...plan.restore, ...plan.diverged]) {
			if (!push.has(path) && !decisions.importPaths.has(path)) {
				undecided.add(path);
				pending++;
			}
		}
		if (pending) {
			warnings.push(get('review.pendingWarning', String(pending)));
		}

		// Objects the fetched branch already holds need no writing, only a tree
		// entry: a file renamed or copied costs nothing
		let texts = [];
		let blobs = [];
		let lfsObjects = [];
		let reused = [];
		let updatedCount = 0;
		let remoteShas = new Set([...remoteFiles.values()].map(entry => entry.sha));
		for (let relPath of [...push].sort()) {
			let upload = uploads.get(relPath);
			if (remote.has(relPath)) {
				updatedCount++;
			}
			if (upload.lfs) {
				lfsObjects.push(upload.lfs);
			}
			if (remoteShas.has(upload.sha)) {
				reused.push(upload);
			}
			else if (upload.bytes) {
				texts.push(upload);
			}
			else {
				blobs.push(upload);
			}
		}
		let addedCount = push.size - updatedCount;

		let saveState = async (commitSha, after) => {
			if (!isFullSync && !base) {
				// A partial sync can't vouch for paths it didn't export
				return;
			}
			let nextBase = Planner.nextBase({ local, remote: after, base, undecided, kept });
			if (!isFullSync && base) {
				// Keep what the partial sync didn't look at
				for (let [path, sha] of base) {
					if (!local.has(path) && !nextBase.has(path)) {
						nextBase.set(path, sha);
					}
				}
			}
			await ZoteroGitSync.State.save(config, { commit: commitSha, base: nextBase });
		};

		if (!push.size && !deletions.length) {
			await saveState(head, remote);
			return { status: 'up-to-date', added: 0, updated: 0, deleted: 0, commit: null, pending, warnings };
		}

		// LFS objects go up before any pointer is pushed, so the branch never
		// references a file LFS doesn't have. Pointers the branch already holds
		// are skipped by git-lfs when the server has the object.
		if (lfsObjects.length) {
			if (!await repo.lfsAvailable()) {
				throw new ZoteroGitSync.GitError(ZoteroGitSync.Git.explain("git: 'lfs' is not a git command"));
			}
			this._updateProgress({ phase: 'uploading-lfs', done: 0, total: lfsObjects.length, bytesDone: 0, bytesTotal: 0 });
			await repo.lfsUpload(lfsObjects, {
				onProgress: (done, total) => this._updateProgress({ phase: 'uploading-lfs', done, total }),
			});
		}

		// -- Store and push in checkpoints -----------------------------------

		let size = u => (u.source ? u.source.size : u.bytes.length);
		let totalFiles = texts.length + blobs.length + reused.length;
		let totalBytes = [...texts, ...blobs].reduce((sum, u) => sum + size(u), 0);
		let doneFiles = 0;
		let doneBytes = 0;
		let showUpload = (extra = {}) => this._updateProgress({
			phase: 'uploading',
			done: doneFiles,
			total: totalFiles,
			bytesDone: doneBytes,
			bytesTotal: totalBytes,
			...extra,
		});
		showUpload();

		let pendingEntries = [];
		let pendingBytes = 0;
		// Bytes stored locally but not pushed yet, for a smooth progress bar
		let unpushedBytes = 0;
		let commitSha = null;
		let checkpoints = 0;

		let commit = async (message) => {
			if (!pendingEntries.length) {
				return;
			}
			this._updateProgress({ phase: 'committing' });
			let tree = await repo.buildTree(head, pendingEntries);
			commitSha = await repo.commitTree({ tree, parents: head ? [head] : [], message });
			let startBytes = doneBytes;
			let batchBytes = unpushedBytes;
			showUpload({ pushing: true });
			await repo.push(commitSha, {
				onProgress: ({ label, percent }) => {
					if (/^Writing objects/i.test(label)) {
						doneBytes = startBytes + Math.floor(batchBytes * percent / 100);
						showUpload({ pushing: true });
					}
				},
			});
			head = commitSha;
			doneBytes = startBytes + batchBytes;
			pendingEntries = [];
			pendingBytes = 0;
			unpushedBytes = 0;
			showUpload();
		};
		let checkpointMessage = () => {
			checkpoints++;
			return `Zotero sync: checkpoint ${checkpoints} (${doneFiles}/${totalFiles} files, `
				+ `${Utils.formatSize(doneBytes + unpushedBytes)}/${Utils.formatSize(totalBytes)})`;
		};

		// Text first: the whole library's metadata and notes reach the server in
		// the first push, before any PDF
		cancel.throwIfCancelled();
		await repo.writeTextBlobs(texts.map(u => ({ sha: u.sha, bytes: u.bytes })));
		for (let upload of [...texts, ...reused]) {
			pendingEntries.push({ path: upload.fullPath, sha: upload.sha });
		}
		doneFiles += texts.length + reused.length;
		unpushedBytes += texts.reduce((sum, u) => sum + size(u), 0);
		if (blobs.length && pendingEntries.length > this.CHECKPOINT_FILES) {
			await commit(checkpointMessage());
		}

		// Then attachment files, in checkpoints: git reads them from storage
		let batch = [];
		let batchBytes = 0;
		let storeBatch = async () => {
			if (!batch.length) {
				return;
			}
			cancel.throwIfCancelled();
			await repo.writeFileBlobs(batch.map(u => ({ path: u.source.path, sha: u.sha })));
			for (let upload of batch) {
				pendingEntries.push({ path: upload.fullPath, sha: upload.sha });
			}
			doneFiles += batch.length;
			pendingBytes += batchBytes;
			unpushedBytes += batchBytes;
			batch = [];
			batchBytes = 0;
			showUpload();
		};
		for (let upload of blobs) {
			batch.push(upload);
			batchBytes += size(upload);
			if (batch.length >= this.STORE_BATCH_FILES || batchBytes >= this.STORE_BATCH_BYTES) {
				await storeBatch();
			}
			if (pendingBytes + batchBytes >= this.CHECKPOINT_BYTES || pendingEntries.length + batch.length >= this.CHECKPOINT_FILES) {
				await storeBatch();
				if (upload !== blobs[blobs.length - 1]) {
					await commit(checkpointMessage());
				}
			}
		}
		await storeBatch();

		// Final commit: whatever is left, and the deletions
		cancel.throwIfCancelled();
		for (let relPath of deletions) {
			pendingEntries.push({ path: prefix + relPath, sha: null });
		}
		await commit(this._commitMessage({
			config,
			trigger,
			added: addedCount,
			updated: updatedCount,
			deleted: deletions.length,
		}));

		let after = new Map(remote);
		for (let relPath of push) {
			after.set(relPath, uploads.get(relPath).sha);
		}
		for (let relPath of deletions) {
			after.delete(relPath);
		}
		await saveState(commitSha, after);
		await repo.maintain();

		return {
			status: 'committed',
			added: addedCount,
			updated: updatedCount,
			deleted: deletions.length,
			commit: commitSha,
			checkpoints,
			pending,
			warnings,
		};
	},


	/**
	 * Everything the review panel shows: titles instead of bare keys, and what
	 * each side holds.
	 */
	async _prepareReview({ plan, repo, remoteFiles, prefix, uploads, remote, config }) {
		let Planner = ZoteroGitSync.Planner;
		let get = (key, ...args) => ZoteroGitSync.getString(key, ...args);
		let parse = (bytes) => {
			try {
				return JSON.parse(ZoteroGitSync.Utils.textDecoder.decode(bytes));
			}
			catch (e) {
				return null;
			}
		};

		// Titles and attachment ownership from the local export
		let titles = new Map();
		let attachmentOwner = new Map();
		let learn = (record) => {
			if (!record?.zotero?.key) {
				return;
			}
			titles.set(record.zotero.key, record.meta?.title || record.zotero.title || record.zotero.key);
			for (let attachment of record.meta?.attachments || []) {
				attachmentOwner.set(attachment.key, { title: record.meta?.title, filename: attachment.filename });
			}
		};
		for (let [relPath, upload] of uploads) {
			if (Planner.importable(relPath)?.kind === 'item' && upload.bytes) {
				learn(parse(upload.bytes));
			}
		}

		// Repository records for items that changed there: their titles and
		// modification dates. Everything is local after the fetch, so read them all.
		let remoteRecords = new Map();
		let wanted = [...plan.incoming, ...plan.conflicts]
			.filter(path => Planner.importable(path)?.kind === 'item' && remoteFiles.has(prefix + path));
		let blobs = await repo.readBlobs(wanted.map(path => remoteFiles.get(prefix + path).sha));
		for (let relPath of wanted) {
			let record = parse(blobs.get(remoteFiles.get(prefix + relPath).sha));
			if (record) {
				remoteRecords.set(relPath, record);
				if (!titles.has(record?.zotero?.key)) {
					learn(record);
				}
			}
		}

		let date = value => (value ? String(value).replace('T', ' ').replace(/Z$/, '') : '?');
		let describe = (relPath) => {
			let info = Planner.importable(relPath);
			if (info?.kind === 'item') {
				return { title: titles.get(info.key) || info.key, kind: 'item' };
			}
			if (info?.kind === 'file') {
				let owner = attachmentOwner.get(info.key);
				return {
					title: owner?.title ? `${owner.title} — ${info.name}` : info.name,
					kind: 'file',
				};
			}
			if (info?.kind === 'library') {
				return { title: get(`review.library.${info.name}`), kind: 'library' };
			}
			let note = relPath.match(/\/notes\/[^/]+\/(.+) \(([A-Z0-9]{8})\)\.md$/);
			if (note) {
				return { title: `${note[1]} (${get('review.markdown')})`, kind: 'derived' };
			}
			return { title: relPath.split('/').pop(), kind: 'derived' };
		};

		let row = relPath => ({ path: relPath, ...describe(relPath) });

		let incoming = plan.incoming.map((relPath) => {
			let r = row(relPath);
			r.detail = get(uploads.has(relPath) ? 'review.changedOnServer' : 'review.addedOnServer');
			return r;
		});

		let conflicts = plan.conflicts.map((relPath) => {
			let r = row(relPath);
			if (r.kind === 'item') {
				let localDate = this._recordDate(parse(uploads.get(relPath)?.bytes));
				let remoteDate = this._recordDate(remoteRecords.get(relPath));
				r.detail = get('review.dates', date(localDate), date(remoteDate));
				r.options = ['local', 'server'];
				r.choice = remoteDate > localDate ? 'server' : 'local';
			}
			else if (r.kind === 'file') {
				r.detail = get('review.fileDiffers');
				r.options = ['local', 'server', 'both'];
				r.choice = 'both';
			}
			else {
				r.detail = get('review.libraryDiffers');
				r.options = ['local', 'server'];
				// "Repository" for a library file merges the repository's entries in
				r.choice = 'server';
			}
			return r;
		});

		let push = new Set(plan.push);
		let server = [
			...[...push].filter(relPath => remote.has(relPath)).map(relPath => ({ ...row(relPath), action: 'update' })),
			...plan.delete.map(relPath => ({ ...row(relPath), action: 'delete' })),
		];

		return {
			repo: ZoteroGitSync.Prefs.getRepoLabel(config),
			counts: {
				add: [...push].filter(relPath => !remote.has(relPath)).length,
				update: server.filter(r => r.action === 'update').length,
				delete: plan.delete.length,
			},
			incoming,
			conflicts,
			overwrite: plan.overwrite.map(relPath => ({ ...row(relPath), detail: get('review.editedOnServer') })),
			restore: plan.restore.map(relPath => ({ ...row(relPath), detail: get('review.deletedOnServer') })),
			server,
		};
	},


	_emptyDecisions() {
		return { importPaths: new Set(), pushPaths: new Set(), keepBoth: new Set(), excluded: new Set() };
	},


	/**
	 * Paths both sides have, that differ, and that this computer has never synced
	 * before. For items the modification date usually says which side is newer;
	 * whatever can't be told apart becomes a conflict.
	 */
	async _resolveDiverged({ plan, repo, remoteFiles, prefix, uploads }) {
		if (!plan.diverged.length) {
			return;
		}
		let Planner = ZoteroGitSync.Planner;
		let items = plan.diverged.filter(relPath => Planner.importable(relPath)?.kind === 'item');
		let others = plan.diverged.filter(relPath => Planner.importable(relPath)?.kind !== 'item');
		let blobs = new Map();
		try {
			blobs = await repo.readBlobs(items.map(relPath => remoteFiles.get(prefix + relPath).sha));
		}
		catch (e) {
			if (e instanceof ZoteroGitSync.CancelledError) {
				throw e;
			}
			ZoteroGitSync.logError(e);
		}
		for (let relPath of items) {
			try {
				let decode = bytes => JSON.parse(ZoteroGitSync.Utils.textDecoder.decode(bytes));
				let localDate = this._recordDate(decode(uploads.get(relPath).bytes));
				let remoteDate = this._recordDate(decode(blobs.get(remoteFiles.get(prefix + relPath).sha)));
				if (remoteDate > localDate) {
					plan.incoming.push(relPath);
				}
				else if (localDate > remoteDate) {
					plan.push.push(relPath);
				}
				else {
					plan.conflicts.push(relPath);
				}
			}
			catch (e) {
				ZoteroGitSync.logError(e);
				plan.conflicts.push(relPath);
			}
		}
		plan.conflicts.push(...others);
		plan.diverged = [];
		for (let key of ['incoming', 'push', 'conflicts']) {
			plan[key].sort();
		}
	},


	/**
	 * @return {String} The latest dateModified in an item record, children included
	 */
	_recordDate(record) {
		let dates = [record?.zotero, ...(record?.children || [])]
			.map(json => json?.dateModified || '')
			.filter(Boolean)
			.sort();
		return dates.length ? dates[dates.length - 1] : '';
	},


	/**
	 * @return {Promise<String[]>} Repository-relative paths written by the last
	 * 		full sync, or [] if this repository has never been synced
	 */
	async _readPreviousFileList(repo, remoteFiles, prefix) {
		let entry = remoteFiles.get(prefix + this.FILE_LIST_PATH);
		if (!entry) {
			return [];
		}
		try {
			let parsed = JSON.parse(await repo.getBlobText(entry.sha));
			return Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string') : [];
		}
		catch (e) {
			if (e instanceof ZoteroGitSync.CancelledError) {
				throw e;
			}
			// Without a readable list we can't tell our files from anyone else's,
			// so skip pruning rather than guess
			ZoteroGitSync.logError(e);
			return [];
		}
	},


	/**
	 * @param {String[]} [warnings]
	 * @return {String} Newline-separated, capped so the preference stays small
	 */
	_formatWarnings(warnings) {
		const MAX = 20;
		if (!warnings?.length) {
			return '';
		}
		let lines = warnings.slice(0, MAX);
		if (warnings.length > MAX) {
			lines.push(`…and ${warnings.length - MAX} more (see Help → Debug Output Logging)`);
		}
		return lines.join('\n');
	},


	_commitMessage({ config, trigger, added, updated, deleted }) {
		let changes = [
			added ? `${added} added` : null,
			updated ? `${updated} updated` : null,
			deleted ? `${deleted} removed` : null,
		].filter(Boolean).join(', ') || 'no changes';

		return (config.commitMessage || 'Zotero sync: {changes} ({date})')
			.replace(/\{changes\}/g, changes)
			.replace(/\{added\}/g, String(added))
			.replace(/\{updated\}/g, String(updated))
			.replace(/\{deleted\}/g, String(deleted))
			.replace(/\{trigger\}/g, trigger)
			.replace(/\{date\}/g, ZoteroGitSync.Utils.isoDate());
	},


	// -- Import ------------------------------------------------------------

	/**
	 * @param {Object} [options]
	 * @param {Boolean} [options.confirm=true] - Ask before touching the library
	 * @return {Promise<Object>}
	 */
	async pull({ confirm = true } = {}) {
		if (this._running) {
			this._openProgressWindow();
			return { status: 'busy' };
		}
		let config = ZoteroGitSync.Prefs.getConfig();
		let token = await ZoteroGitSync.Prefs.getToken();
		if (!config.remoteURL) {
			this._notify(ZoteroGitSync.getString('error.notConfigured'), { error: true });
			return { status: 'not-configured' };
		}

		if (confirm) {
			let win = Zotero.getMainWindow();
			let accepted = Services.prompt.confirm(
				win,
				ZoteroGitSync.getString('confirm.pullTitle'),
				ZoteroGitSync.getString('confirm.pullBody', ZoteroGitSync.Prefs.getRepoLabel(config))
			);
			if (!accepted) {
				return { status: 'cancelled' };
			}
		}

		this._running = true;
		this._cancel = new ZoteroGitSync.CancelToken();
		this._suppressChangeTrigger = true;
		this.progress = null;
		this._setStatus('syncing');
		this._updateProgress({ phase: 'importing', message: ZoteroGitSync.getString('progress.importing') });
		this._openProgressWindow();

		try {
			let result = await ZoteroGitSync.Importer.run({
				config,
				token,
				cancel: this._cancel,
				onProgress: message => this._updateProgress({ phase: 'importing', message }),
			});
			ZoteroGitSync.Prefs.set('lastWarnings', this._formatWarnings(result.failures));
			this.progress = null;
			this._setStatus('idle');
			let summary = ZoteroGitSync.getString(
				'progress.imported',
				String(result.created),
				String(result.updated),
				String(result.files)
			);
			if (result.failures.length) {
				summary += `\n${ZoteroGitSync.getString('progress.warnings', String(result.failures.length))}`;
			}
			this._finishProgressWindow(summary);
			return result;
		}
		catch (e) {
			this.progress = null;
			if (e instanceof ZoteroGitSync.CancelledError) {
				this._setStatus('idle');
				this._finishProgressWindow(ZoteroGitSync.getString('progress.cancelled'));
				return { status: 'cancelled' };
			}
			ZoteroGitSync.logError(e);
			ZoteroGitSync.Prefs.set('lastError', e.message || String(e));
			this._setStatus('error');
			this._progressWindow?.close();
			this._progressWindow = null;
			this._notify(e.message || String(e), { error: true });
			return { status: 'error', error: e.message || String(e) };
		}
		finally {
			this._running = false;
			this._cancel = null;
			this._suppressChangeTrigger = false;
		}
	},


	// -- Feedback ----------------------------------------------------------
	//
	// Nothing here is modal. A dialog that the window manager draws at the wrong
	// size can leave Zotero unusable, and progress is always visible on the
	// toolbar button anyway.

	_openProgressWindow() {
		if (this._progressWindow) {
			return;
		}
		try {
			let win = new Zotero.ProgressWindow({ closeOnClick: false });
			win.changeHeadline(ZoteroGitSync.getString('progress.headline'));
			let line = new win.ItemProgress(`${ZoteroGitSync.rootURI}content/icons/git-20.svg`, '');
			win.show();
			this._progressWindow = win;
			this._progressLine = line;
			this._renderProgressWindow();
		}
		catch (e) {
			ZoteroGitSync.logError(e);
		}
	},


	_renderProgressWindow() {
		if (!this._progressWindow || !this._progressLine || !this.progress) {
			return;
		}
		try {
			this._progressLine.setText(this.describeProgress());
			let percent = this.percent();
			if (percent !== null) {
				this._progressLine.setProgress(percent);
			}
		}
		catch (e) {
			// The window was closed by the user
			this._progressWindow = null;
			this._progressLine = null;
		}
	},


	_finishProgressWindow(summary) {
		let win = this._progressWindow;
		this._progressWindow = null;
		this._progressLine = null;
		if (!win) {
			return;
		}
		try {
			win.close();
		}
		catch (e) {}
		this._notify(summary);
	},


	/**
	 * A passive notification in the corner of the window.
	 *
	 * @param {String} message
	 * @param {Object} [options]
	 * @param {Boolean} [options.error]
	 */
	_notify(message, { error = false } = {}) {
		try {
			let win = new Zotero.ProgressWindow({ closeOnClick: true });
			win.changeHeadline(ZoteroGitSync.getString(error ? 'progress.failed' : 'progress.headline'));
			for (let line of String(message).split('\n')) {
				win.addDescription(line);
			}
			win.show();
			win.startCloseTimer(error ? 15000 : 6000);
		}
		catch (e) {
			ZoteroGitSync.logError(e);
		}
	},
};
