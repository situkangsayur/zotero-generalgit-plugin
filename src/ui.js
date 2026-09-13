/* Zotero Git Sync -- menus, toolbar button and status feedback
 *
 * Everything added to a window is recorded so removeFromWindow() can take it all
 * back out again when the plugin is disabled or upgraded, which Zotero requires
 * of bootstrapped plugins.
 */

ZoteroGitSync.UI = {
	// window -> Element[] we created
	_added: new WeakMap(),
	_windows: new Set(),


	addToWindow(win) {
		if (this._added.has(win)) {
			return;
		}
		let elements = [];
		this._added.set(win, elements);
		this._windows.add(win);

		for (let add of [
			'_addStylesheet',
			'_addToolbarButton',
			'_addToolsMenu',
			'_addItemContextMenu',
			'_addCollectionContextMenu',
		]) {
			try {
				this[add](win, elements);
			}
			catch (e) {
				ZoteroGitSync.logError(e);
			}
		}
		this.onStatusChange(ZoteroGitSync.Sync.status, ZoteroGitSync.Sync.progress);
	},


	removeFromWindow(win) {
		let elements = this._added.get(win);
		if (elements) {
			for (let element of elements) {
				element.remove();
			}
			this._added.delete(win);
		}
		this._windows.delete(win);
	},


	/**
	 * Reflect sync state and progress on every open window's toolbar button.
	 *
	 * @param {String} status - idle | syncing | error
	 * @param {Object|null} progress - Sync.progress
	 */
	onStatusChange(status, progress) {
		let Sync = ZoteroGitSync.Sync;
		let get = (key, ...args) => ZoteroGitSync.getString(key, ...args);
		let lines = [get('progress.headline')];
		if (status === 'syncing') {
			lines.push(Sync.describeProgress(progress) || get('progress.collecting'), get('toolbar.clickForProgress'));
		}
		else if (status === 'attention') {
			lines.push(get('toolbar.attention', String(Sync.pendingReview || ZoteroGitSync.Prefs.get('pendingReview') || '')));
		}
		else {
			let lastError = ZoteroGitSync.Prefs.get('lastError');
			let lastSync = ZoteroGitSync.Prefs.get('lastSync');
			if (status === 'error' && lastError) {
				lines.push(get('toolbar.lastError', lastError));
			}
			lines.push(lastSync ? get('toolbar.lastSync', new Date(lastSync).toLocaleString()) : get('toolbar.never'));
			lines.push(get('toolbar.clickToSync'));
		}
		let tooltip = lines.join('\n');
		let percent = status === 'syncing' ? Sync.percent(progress) : null;

		for (let win of this._windows) {
			let button = win.document?.getElementById('zotero-git-sync-button');
			if (!button) {
				continue;
			}
			button.setAttribute('zgit-status', status);
			button.setAttribute('tooltiptext', tooltip);
			button.setAttribute('label', percent === null ? '' : `${percent}%`);
		}
	},


	// -- Builders ----------------------------------------------------------

	_addStylesheet(win, elements) {
		let doc = win.document;
		let link = doc.createElementNS('http://www.w3.org/1999/xhtml', 'link');
		link.id = 'zotero-git-sync-stylesheet';
		link.setAttribute('rel', 'stylesheet');
		link.setAttribute('href', `${ZoteroGitSync.rootURI}content/toolbar.css`);
		doc.documentElement.appendChild(link);
		elements.push(link);

		let reviewLink = doc.createElementNS('http://www.w3.org/1999/xhtml', 'link');
		reviewLink.id = 'zotero-git-sync-review-stylesheet';
		reviewLink.setAttribute('rel', 'stylesheet');
		reviewLink.setAttribute('href', `${ZoteroGitSync.rootURI}content/review.css`);
		doc.documentElement.appendChild(reviewLink);
		elements.push(reviewLink);
	},


	_addToolbarButton(win, elements) {
		let doc = win.document;
		// Beside Zotero's own sync button in the title bar; the items toolbar is
		// the fallback for layouts that don't have one
		let zoteroSync = doc.getElementById('zotero-tb-sync');
		let container = zoteroSync?.parentNode || doc.getElementById('zotero-items-toolbar');
		if (!container) {
			return;
		}

		let button = doc.createXULElement('toolbarbutton');
		button.id = 'zotero-git-sync-button';
		button.className = 'zotero-tb-button';
		button.setAttribute('tabindex', '-1');
		button.setAttribute('zgit-status', 'idle');

		let popup = doc.createXULElement('menupopup');
		popup.id = 'zotero-git-sync-button-menu';
		let rebuild = () => {
			popup.replaceChildren();
			let running = ZoteroGitSync.Sync.isRunning;
			let entries = running
				? [
					{ label: ZoteroGitSync.getString('menu.showProgress'), command: () => ZoteroGitSync.Sync._openProgressWindow() },
					{ label: ZoteroGitSync.getString('menu.cancel'), command: () => ZoteroGitSync.Sync.cancel() },
					{ separator: true },
				]
				: [];
			for (let entry of [...entries, ...this._menuEntries(win)]) {
				let item = this._createMenuItem(doc, entry);
				if (running && ['sync-now', 'review', 'sync-selected', 'pull'].includes(entry.id)) {
					item.setAttribute('disabled', 'true');
				}
				popup.append(item);
			}
		};
		popup.addEventListener('popupshowing', rebuild);

		button.addEventListener('command', () => {
			let Sync = ZoteroGitSync.Sync;
			if (Sync.isRunning) {
				Sync._openProgressWindow();
				return;
			}
			Sync.syncNow({ trigger: 'button', forceReview: Sync.status === 'attention' })
				.catch(e => ZoteroGitSync.logError(e));
		});
		button.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			popup.openPopup(button, 'after_end', 0, 0, true, false, event);
		});

		let popupset = doc.querySelector('popupset') || doc.documentElement;
		popupset.append(popup);
		elements.push(popup);

		if (zoteroSync) {
			container.insertBefore(button, zoteroSync);
		}
		else {
			container.append(button);
		}
		elements.push(button);
	},


	_addToolsMenu(win, elements) {
		let doc = win.document;
		let toolsPopup = doc.getElementById('menu_ToolsPopup');
		if (!toolsPopup) {
			return;
		}

		let menu = doc.createXULElement('menu');
		menu.id = 'zotero-git-sync-tools-menu';
		menu.setAttribute('label', ZoteroGitSync.getString('menu.root'));

		let popup = doc.createXULElement('menupopup');
		for (let entry of this._menuEntries(win)) {
			popup.append(this._createMenuItem(doc, entry));
		}
		menu.append(popup);
		toolsPopup.append(menu);
		elements.push(menu);
	},


	_addItemContextMenu(win, elements) {
		let doc = win.document;
		let itemMenu = doc.getElementById('zotero-itemmenu');
		if (!itemMenu) {
			return;
		}

		let separator = doc.createXULElement('menuseparator');
		separator.id = 'zotero-git-sync-item-separator';

		let menuitem = doc.createXULElement('menuitem');
		menuitem.id = 'zotero-git-sync-item-menuitem';
		menuitem.setAttribute('label', ZoteroGitSync.getString('menu.syncSelected'));
		menuitem.addEventListener('command', () => this._syncSelectedItems(win));

		// ZoteroPane rebuilds this menu by index, so appended items survive, but
		// their visibility is ours to manage
		let onPopupShowing = () => {
			let selected = this._getSelectedItems(win);
			let visible = ZoteroGitSync.Prefs.hasRepoConfig() && selected.length > 0;
			separator.hidden = !visible;
			menuitem.hidden = !visible;
		};
		itemMenu.addEventListener('popupshowing', onPopupShowing);
		elements.push({
			remove: () => {
				itemMenu.removeEventListener('popupshowing', onPopupShowing);
				separator.remove();
				menuitem.remove();
			},
		});

		itemMenu.append(separator, menuitem);
	},


	_addCollectionContextMenu(win, elements) {
		let doc = win.document;
		let collectionMenu = doc.getElementById('zotero-collectionmenu');
		if (!collectionMenu) {
			return;
		}

		let menuitem = doc.createXULElement('menuitem');
		menuitem.id = 'zotero-git-sync-collection-menuitem';
		menuitem.setAttribute('label', ZoteroGitSync.getString('menu.syncCollection'));
		menuitem.addEventListener('command', () => this._syncSelectedCollection(win));

		let onPopupShowing = () => {
			let collection = win.ZoteroPane?.getSelectedCollection?.();
			menuitem.hidden = !(collection && ZoteroGitSync.Prefs.hasRepoConfig());
		};
		collectionMenu.addEventListener('popupshowing', onPopupShowing);
		elements.push({
			remove: () => {
				collectionMenu.removeEventListener('popupshowing', onPopupShowing);
				menuitem.remove();
			},
		});

		collectionMenu.append(menuitem);
	},


	/**
	 * The entries shared by the Tools menu and the toolbar dropdown.
	 */
	_menuEntries(win) {
		return [
			{
				id: 'sync-now',
				label: ZoteroGitSync.getString('menu.syncNow'),
				command: () => ZoteroGitSync.Sync.syncNow({ trigger: 'menu' })
					.catch(e => ZoteroGitSync.logError(e)),
			},
			{
				id: 'review',
				label: ZoteroGitSync.getString('menu.review'),
				command: () => ZoteroGitSync.Sync.syncNow({ trigger: 'review', forceReview: true })
					.catch(e => ZoteroGitSync.logError(e)),
			},
			{
				id: 'sync-selected',
				label: ZoteroGitSync.getString('menu.syncSelected'),
				command: () => this._syncSelectedItems(win),
			},
			{
				id: 'pull',
				label: ZoteroGitSync.getString('menu.pull'),
				command: () => ZoteroGitSync.Sync.pull()
					.catch(e => ZoteroGitSync.logError(e)),
			},
			{ id: 'separator', separator: true },
			{
				id: 'open-repo',
				label: ZoteroGitSync.getString('menu.openRepo'),
				command: () => {
					let url = ZoteroGitSync.Prefs.getRepoURL();
					if (url) {
						Zotero.launchURL(url);
					}
					else {
						// A server with no web interface, or no repository set yet
						this._openPreferences();
					}
				},
			},
			{
				id: 'settings',
				label: ZoteroGitSync.getString('menu.settings'),
				command: () => this._openPreferences(),
			},
		];
	},


	_createMenuItem(doc, entry) {
		if (entry.separator) {
			return doc.createXULElement('menuseparator');
		}
		let menuitem = doc.createXULElement('menuitem');
		menuitem.setAttribute('label', entry.label);
		menuitem.addEventListener('command', entry.command);
		return menuitem;
	},


	// -- Actions -----------------------------------------------------------

	_getSelectedItems(win) {
		try {
			let items = win.ZoteroPane?.getSelectedItems?.() || [];
			// Syncing a note or attachment on its own has no meaning here; the
			// exporter writes children alongside their parent
			return items
				.map(item => (item.isTopLevelItem() ? item : item.parentItem))
				.filter((item, index, all) => item && all.indexOf(item) === index);
		}
		catch (e) {
			ZoteroGitSync.logError(e);
			return [];
		}
	},


	_syncSelectedItems(win) {
		let items = this._getSelectedItems(win);
		ZoteroGitSync.Sync.syncNow({ trigger: 'selection', items })
			.catch(e => ZoteroGitSync.logError(e));
	},


	async _syncSelectedCollection(win) {
		try {
			let collection = win.ZoteroPane?.getSelectedCollection?.();
			if (!collection) {
				return;
			}
			let items = collection.getChildItems(false, false) || [];
			// Include everything filed under subcollections too, which is what
			// "sync this collection" means to anyone looking at the tree
			for (let child of collection.getDescendents(false, 'collection') || []) {
				let subcollection = Zotero.Collections.get(child.id);
				if (subcollection) {
					items.push(...(subcollection.getChildItems(false, false) || []));
				}
			}
			let unique = items.filter((item, index) => items.indexOf(item) === index);
			await ZoteroGitSync.Sync.syncNow({ trigger: 'collection', items: unique });
		}
		catch (e) {
			ZoteroGitSync.logError(e);
		}
	},


	_openPreferences() {
		try {
			Zotero.Utilities.Internal.openPreferences(ZoteroGitSync.prefPaneID);
		}
		catch (e) {
			ZoteroGitSync.logError(e);
		}
	},
};
