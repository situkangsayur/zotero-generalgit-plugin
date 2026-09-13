/* Zotero Git Sync -- namespace, lifecycle and localized strings */

var ZoteroGitSync = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	prefPaneID: null,
	
	PREF_BRANCH: 'extensions.zotero-git-sync.',
	
	
	async init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		
		this.Prefs.migrate();
		this.Sync.init();
		await this.registerPrefPane();

		// The preference pane runs in the preferences window, which can't see
		// this sandbox; the Zotero global is the one thing both sides share
		Zotero.GitSync = this;
		
		this.initialized = true;
		this.log(`Initialized v${version}`);
	},
	
	
	async shutdown() {
		this.log('Shutting down');
		for (let win of Zotero.getMainWindows()) {
			try {
				this.UI.removeFromWindow(win);
			}
			catch (e) {
				this.logError(e);
			}
		}
		this.Sync.shutdown();
		if (this.prefPaneID) {
			try {
				Zotero.PreferencePanes.unregister(this.prefPaneID);
			}
			catch (e) {
				this.logError(e);
			}
			this.prefPaneID = null;
		}
		if (Zotero.GitSync === this) {
			delete Zotero.GitSync;
		}
		this.initialized = false;
	},
	
	
	async registerPrefPane() {
		try {
			this.prefPaneID = await Zotero.PreferencePanes.register({
				pluginID: this.id,
				src: this.rootURI + 'content/preferences.xhtml',
				scripts: [this.rootURI + 'content/preferences.js'],
				stylesheets: [this.rootURI + 'content/preferences.css'],
				image: this.rootURI + 'content/icons/git-48.svg',
				label: 'Git Sync',
				helpURL: 'https://github.com/situkangsayur/zotero-generalgit-plugin#readme',
			});
		}
		catch (e) {
			this.logError(e);
		}
	},
	
	
	// -- Logging -----------------------------------------------------------
	
	log(msg) {
		Zotero.debug(`[Git Sync] ${msg}`);
	},
	
	warn(msg) {
		Zotero.warn(`[Git Sync] ${msg}`);
	},
	
	logError(e) {
		Zotero.logError(e instanceof Error ? e : new Error(`[Git Sync] ${e}`));
	},
	
	
	// -- Strings -----------------------------------------------------------
	
	// Kept as a plain table rather than Fluent so the plugin works unchanged on
	// every Zotero 7+ build. Add a locale by adding a key to `_strings`.
	_strings: {
		'en-US': {
			'menu.root': 'Git Sync',
			'menu.syncNow': 'Sync Library Now',
			'menu.syncSelected': 'Sync Selected Items to Git',
			'menu.syncCollection': 'Sync This Collection to Git',
			'menu.pull': 'Import from Git…',
			'menu.openRepo': 'Open Repository in Browser',
			'menu.settings': 'Git Sync Settings…',
			'menu.cancel': 'Cancel Git Sync',
			'menu.review': 'Review Changes and Sync…',
			'menu.showProgress': 'Show Progress',
			'toolbar.tooltip': 'Sync library to Git',
			'toolbar.tooltipSyncing': 'Syncing to Git…',
			'toolbar.lastSync': 'Last sync: %S',
			'toolbar.never': 'Not synced yet',
			'toolbar.lastError': 'Last sync failed: %S',
			'toolbar.clickToSync': 'Click to sync, right-click for more',
			'toolbar.clickForProgress': 'Click to show progress, right-click to cancel',
			'toolbar.attention': '%S change(s) in the repository need your review — click to review',
			'progress.headline': 'Git Sync',
			'progress.collecting': 'Collecting library data…',
			'progress.fetching': 'Fetching %S…',
			'progress.comparing': 'Comparing with repository…',
			'progress.hashing': 'Checking attachment files: %S of %S',
			'progress.uploadingCount': 'Storing %S of %S files (%S of %S)',
			'progress.pushingCount': 'Pushing to the server: %S of %S files (%S of %S)',
			'progress.uploadingLFSCount': 'Uploading large files to Git LFS: %S of %S',
			'progress.cancelling': 'Cancelling…',
			'progress.cancelled': 'Sync cancelled. Checkpoints already pushed stay in the repository.',
			'progress.warnings': '%S file(s) skipped -- see Settings → Git Sync',
			'progress.restoring': 'Restoring attachment files…',
			'progress.committing': 'Creating commit…',
			'progress.done': 'Synced %S file(s) to %S',
			'progress.upToDate': 'Already up to date',
			'progress.failed': 'Git sync failed',
			'progress.importing': 'Importing from Git…',
			'progress.imported': 'Imported %S item(s), updated %S, restored %S file(s)',
			'review.preparing': 'Preparing the review…',
			'review.importing': 'Importing %S accepted change(s)…',
			'review.pendingWarning': '%S change(s) in the repository were left for review and not overwritten',
			'review.pendingSummary': '%S change(s) need review: click the Git Sync button',
			'review.heading': 'Review sync with %S',
			'review.counts': 'This sync adds %S file(s), replaces %S and deletes %S in the repository.',
			'review.summary': '%S change(s) will be imported into Zotero · %S file(s) excluded',
			'review.all': 'All',
			'review.none': 'None',
			'review.cancel': 'Cancel',
			'review.confirm': 'Sync',
			'review.nothing': 'Nothing needs a decision. Sync uploads your changes.',
			'review.incoming': 'Changes in the repository',
			'review.incomingHelp': 'Changed or added in the repository, or by another computer, and not changed here. Ticked items are imported into Zotero before syncing; unticked ones stay as they are and are asked about again next time.',
			'review.import': 'Import into Zotero',
			'review.conflicts': 'Changed in both places',
			'review.conflictsHelp': 'Choose which version to keep. "Keep both" adds the repository file as a second attachment.',
			'review.choice.local': 'Zotero',
			'review.choice.server': 'Repository',
			'review.choice.both': 'Keep both',
			'review.restore': 'Deleted in the repository, still in Zotero',
			'review.restoreHelp': 'Ticked files are uploaded again. Nothing is deleted from your library; to accept the deletion, delete the item in Zotero and sync.',
			'review.uploadAgain': 'Upload again',
			'review.overwrite': 'Edited in the repository, generated by the plugin',
			'review.overwriteHelp': 'These files are regenerated from your library on every sync; edits made in the repository are replaced. Untick to leave them alone this time.',
			'review.overwriteLabel': 'Replace',
			'review.server': 'Files this sync replaces or deletes in the repository',
			'review.serverHelp': 'Your changes in Zotero. Untick a file to exclude it from this sync.',
			'review.apply': 'Include in this sync',
			'review.willReplace': 'will be replaced',
			'review.willDelete': 'will be deleted',
			'review.changedOnServer': 'changed in the repository',
			'review.addedOnServer': 'only in the repository',
			'review.editedOnServer': 'edited in the repository',
			'review.deletedOnServer': 'deleted in the repository',
			'review.dates': 'modified in Zotero %S · in the repository %S',
			'review.fileDiffers': 'the file differs',
			'review.libraryDiffers': '"Repository" merges its entries into Zotero',
			'review.markdown': 'Markdown note',
			'review.library.collections': 'Collections',
			'review.library.searches': 'Saved searches',
			'review.library.settings': 'Tag colors',
			'warning.lfsMissing': 'Git LFS is turned on but git-lfs is not installed on this computer: large files were committed to Git directly (up to %S) instead. Install git-lfs, or turn Git LFS off to hide this message.',
			'error.notConfigured': 'Set the repository address in Settings → Git Sync first.',
			'error.noItems': 'No items selected.',
			'error.running': 'A sync is already running.',
			'confirm.pullTitle': 'Import from Git',
			'confirm.pullBody': 'This reads items from %S and adds items missing from your library, '
				+ 'updating existing ones only when the repository copy is newer. '
				+ 'Nothing in your library is deleted. Continue?',
		},
		id: {
			'menu.root': 'Git Sync',
			'menu.syncNow': 'Sinkronkan Pustaka Sekarang',
			'menu.syncSelected': 'Sinkronkan Item Terpilih ke Git',
			'menu.syncCollection': 'Sinkronkan Koleksi Ini ke Git',
			'menu.pull': 'Impor dari Git…',
			'menu.openRepo': 'Buka Repositori di Browser',
			'menu.settings': 'Pengaturan Git Sync…',
			'menu.cancel': 'Batalkan Git Sync',
			'menu.review': 'Tinjau Perubahan dan Sinkronkan…',
			'menu.showProgress': 'Tampilkan Progres',
			'toolbar.tooltip': 'Sinkronkan pustaka ke Git',
			'toolbar.tooltipSyncing': 'Menyinkronkan ke Git…',
			'toolbar.lastSync': 'Sinkronisasi terakhir: %S',
			'toolbar.never': 'Belum pernah disinkronkan',
			'toolbar.lastError': 'Sinkronisasi terakhir gagal: %S',
			'toolbar.clickToSync': 'Klik untuk sinkron, klik kanan untuk menu',
			'toolbar.clickForProgress': 'Klik untuk melihat progres, klik kanan untuk batal',
			'toolbar.attention': '%S perubahan di repositori perlu ditinjau — klik untuk meninjau',
			'progress.headline': 'Git Sync',
			'progress.collecting': 'Mengumpulkan data pustaka…',
			'progress.fetching': 'Mengambil %S…',
			'progress.comparing': 'Membandingkan dengan repositori…',
			'progress.hashing': 'Memeriksa berkas lampiran: %S dari %S',
			'progress.uploadingCount': 'Menyimpan %S dari %S berkas (%S dari %S)',
			'progress.pushingCount': 'Mengirim ke server: %S dari %S berkas (%S dari %S)',
			'progress.uploadingLFSCount': 'Mengunggah berkas besar ke Git LFS: %S dari %S',
			'progress.cancelling': 'Membatalkan…',
			'progress.cancelled': 'Sinkronisasi dibatalkan. Checkpoint yang sudah dikirim tetap ada di repositori.',
			'progress.warnings': '%S berkas dilewati -- lihat Pengaturan → Git Sync',
			'progress.restoring': 'Memulihkan berkas lampiran…',
			'progress.committing': 'Membuat commit…',
			'progress.done': '%S berkas tersinkron ke %S',
			'progress.upToDate': 'Sudah paling baru',
			'progress.failed': 'Git sync gagal',
			'progress.importing': 'Mengimpor dari Git…',
			'progress.imported': '%S item diimpor, %S diperbarui, %S berkas dipulihkan',
			'review.preparing': 'Menyiapkan tinjauan…',
			'review.importing': 'Mengimpor %S perubahan yang diterima…',
			'review.pendingWarning': '%S perubahan di repositori dibiarkan untuk ditinjau dan tidak ditimpa',
			'review.pendingSummary': '%S perubahan perlu ditinjau: klik tombol Git Sync',
			'review.heading': 'Tinjau sinkronisasi dengan %S',
			'review.counts': 'Sinkronisasi ini menambah %S berkas, mengganti %S dan menghapus %S di repositori.',
			'review.summary': '%S perubahan akan diimpor ke Zotero · %S berkas dikecualikan',
			'review.all': 'Semua',
			'review.none': 'Tidak ada',
			'review.cancel': 'Batal',
			'review.confirm': 'Sinkronkan',
			'review.nothing': 'Tidak ada yang perlu diputuskan. Sinkronisasi akan mengunggah perubahan Anda.',
			'review.incoming': 'Perubahan di repositori',
			'review.incomingHelp': 'Diubah atau ditambahkan di repositori, atau oleh komputer lain, dan tidak diubah di sini. Yang dicentang diimpor ke Zotero sebelum sinkron; yang tidak dicentang dibiarkan dan ditanyakan lagi lain kali.',
			'review.import': 'Impor ke Zotero',
			'review.conflicts': 'Berubah di kedua tempat',
			'review.conflictsHelp': 'Pilih versi yang disimpan. "Simpan keduanya" menambahkan berkas dari repositori sebagai lampiran kedua.',
			'review.choice.local': 'Zotero',
			'review.choice.server': 'Repositori',
			'review.choice.both': 'Simpan keduanya',
			'review.restore': 'Dihapus di repositori, masih ada di Zotero',
			'review.restoreHelp': 'Berkas yang dicentang diunggah lagi. Tidak ada yang dihapus dari pustaka Anda; untuk menerima penghapusan, hapus item itu di Zotero lalu sinkronkan.',
			'review.uploadAgain': 'Unggah lagi',
			'review.overwrite': 'Diedit di repositori, dibuat oleh plugin',
			'review.overwriteHelp': 'Berkas ini dibuat ulang dari pustaka setiap sinkron; editan di repositori akan diganti. Hilangkan centang untuk membiarkannya kali ini.',
			'review.overwriteLabel': 'Ganti',
			'review.server': 'Berkas yang diganti atau dihapus di repositori oleh sinkron ini',
			'review.serverHelp': 'Perubahan Anda di Zotero. Hilangkan centang untuk mengecualikan berkas dari sinkron ini.',
			'review.apply': 'Ikutkan di sinkron ini',
			'review.willReplace': 'akan diganti',
			'review.willDelete': 'akan dihapus',
			'review.changedOnServer': 'diubah di repositori',
			'review.addedOnServer': 'hanya ada di repositori',
			'review.editedOnServer': 'diedit di repositori',
			'review.deletedOnServer': 'dihapus di repositori',
			'review.dates': 'diubah di Zotero %S · di repositori %S',
			'review.fileDiffers': 'isi berkas berbeda',
			'review.libraryDiffers': '"Repositori" menggabungkan isinya ke Zotero',
			'review.markdown': 'catatan Markdown',
			'review.library.collections': 'Koleksi',
			'review.library.searches': 'Saved search',
			'review.library.settings': 'Warna tag',
			'warning.lfsMissing': 'Git LFS aktif tetapi git-lfs tidak terpasang di komputer ini: berkas besar langsung di-commit ke Git (sampai %S). Pasang git-lfs, atau matikan Git LFS agar pesan ini hilang.',
			'error.notConfigured': 'Isi alamat repositori di Pengaturan → Git Sync terlebih dahulu.',
			'error.noItems': 'Tidak ada item yang dipilih.',
			'error.running': 'Sinkronisasi sedang berjalan.',
			'confirm.pullTitle': 'Impor dari Git',
			'confirm.pullBody': 'Ini membaca item dari %S lalu menambahkan item yang belum ada di pustaka Anda, '
				+ 'dan memperbarui item yang salinan repositorinya lebih baru. '
				+ 'Tidak ada data pustaka yang dihapus. Lanjutkan?',
		},
	},
	
	/**
	 * @param {String} key
	 * @param {...String} args - Substituted for %S placeholders, in order
	 * @return {String}
	 */
	getString(key, ...args) {
		let locale = Zotero.locale || 'en-US';
		let table = this._strings[locale]
			|| this._strings[locale.split('-')[0]]
			|| this._strings['en-US'];
		let str = table[key] ?? this._strings['en-US'][key] ?? key;
		for (let arg of args) {
			str = str.replace('%S', arg);
		}
		return str;
	},
};
