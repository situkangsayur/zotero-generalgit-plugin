/* Zotero Git Sync -- tests for the 0.1.4 fixes
 *
 * DEVELOPMENT ONLY. Three throwaway profiles take turns against one throwaway
 * repository (see scripts/fixes-test/run-remote.sh); each Zotero launch runs
 * one step, named by ZGIT_STEP, writes ZGIT_OUT/<step>.json and quits.
 *
 * What each step proves, all three reported by a reader of the source:
 *
 *   F1  A builds a library with a multi-file attachment and syncs it up
 *   F2  "Remove files from the repository when their items are deleted" OFF:
 *       an item deleted here must stay on the server
 *   F3  the same preference ON: now it goes
 *   F4  B starts empty and imports everything
 *   F5  A edits every file of the multi-file attachment and syncs
 *   F6  B edited them too and picks "keep both": every repository copy must
 *       arrive, not just the first (they share one temporary folder)
 *   F7  C imports a repository whose tree holds `../escape.txt` under an
 *       attachment: nothing may be written outside the storage folder
 */

var log = msg => Zotero.debug(`[ZGIT fixes test] ${msg}`);
var sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function install() {}
function uninstall() {}
function shutdown() {}

async function startup() {
	await Zotero.initializationPromise;
	let step = Services.env.get('ZGIT_STEP');
	let outDir = Services.env.get('ZGIT_OUT');
	if (!step || !outDir) {
		return;
	}
	let report = { step };
	try {
		await run(step, report);
		report.ok = true;
	}
	catch (e) {
		Zotero.logError(e);
		report.ok = false;
		report.error = `${e}\n${e.stack}`;
	}
	await IOUtils.writeJSON(PathUtils.join(outDir, `${step}.json`), report);
	await IOUtils.writeUTF8(PathUtils.join(outDir, `${step}.done`), report.ok ? 'ok\n' : 'error\n');
	setTimeout(() => Zotero.Utilities.Internal.quit(), 2000);
}


// The snapshot's three files, the shape that broke "keep both"
var SNAPSHOT = ['index.html', 'page/style.css', 'page/figure.txt'];

function libraryID() {
	return Zotero.Libraries.userLibraryID;
}

async function items() {
	return (await Zotero.Items.getAll(libraryID(), true, false)).filter(i => !i.deleted && i.isTopLevelItem() && !i.isAnnotation());
}

async function byTitle(prefix) {
	return (await items()).find(i => (i.getField('title') || '').startsWith(prefix));
}

async function addItem(type, title, fields = {}) {
	let item = new Zotero.Item(type);
	item.libraryID = libraryID();
	item.setField('title', title);
	for (let [field, value] of Object.entries(fields)) {
		item.setField(field, value);
	}
	await item.saveTx();
	return item;
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}


/**
 * A snapshot-like attachment: several files in one storage folder, which is
 * what a saved web page looks like.
 */
async function createSnapshot(parent, marker) {
	let dir = PathUtils.join(Zotero.getTempDirectory().path, 'zgit-fixes-source');
	await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
	let index = PathUtils.join(dir, 'index.html');
	await IOUtils.writeUTF8(index, `<html><body>snapshot ${marker}</body></html>\n`);
	let attachment = await Zotero.Attachments.importFromFile({ file: index, parentItemID: parent.id, title: 'Snapshot' });
	let storage = Zotero.Attachments.getStorageDirectory(attachment).path;
	await IOUtils.makeDirectory(PathUtils.join(storage, 'page'), { ignoreExisting: true, createAncestors: true });
	await IOUtils.writeUTF8(PathUtils.join(storage, 'page', 'style.css'), `body { color: ${marker}; }\n`);
	await IOUtils.writeUTF8(PathUtils.join(storage, 'page', 'figure.txt'), `figure ${marker}\n`);
	return attachment;
}

async function rewriteSnapshot(marker) {
	let snapshot = (await byTitle('Snapshot Paper'));
	let attachment = Zotero.Items.get(snapshot.getAttachments(false)[0]);
	let storage = Zotero.Attachments.getStorageDirectory(attachment).path;
	await IOUtils.writeUTF8(PathUtils.join(storage, 'index.html'), `<html><body>snapshot ${marker}</body></html>\n`);
	await IOUtils.writeUTF8(PathUtils.join(storage, 'page', 'style.css'), `body { color: ${marker}; }\n`);
	await IOUtils.writeUTF8(PathUtils.join(storage, 'page', 'figure.txt'), `figure ${marker}\n`);
	// The export reads the hash cache, which keys on size and date
	await sleep(1100);
	return attachment;
}


/**
 * Stand in for the review panel: `script` decides each row the way a person
 * would click it.
 */
function scriptReview(plugin, report, script = {}) {
	plugin.Review.ask = async (review) => {
		report.review = {
			incoming: review.incoming.map(r => r.title),
			conflicts: review.conflicts.map(r => ({ path: r.path, options: r.options, default: r.choice })),
			counts: review.counts,
			server: review.server.map(r => `${r.action}: ${r.path}`),
		};
		let checks = { incoming: new Map(), overwrite: new Map(), restore: new Map(), server: new Map() };
		let choices = new Map();
		for (let row of review.incoming) {
			checks.incoming.set(row.path, script.accept ? script.accept(row) : true);
		}
		for (let row of review.conflicts) {
			choices.set(row.path, script.choose ? script.choose(row) : row.choice);
		}
		for (let id of ['overwrite', 'restore', 'server']) {
			for (let row of review[id]) {
				checks[id].set(row.path, true);
			}
		}
		return plugin.Review._decisions(review, checks, choices);
	};
}


/** Every path in the repository's tree, relative to the base path. */
async function repoPaths(plugin, config) {
	let repo = await plugin.Sync.openRepository(config);
	let head = await repo.fetch();
	if (!head) {
		return [];
	}
	let prefix = config.basePath ? `${config.basePath}/` : '';
	return [...(await repo.listTree(head)).keys()]
		.filter(path => path.startsWith(prefix))
		.map(path => path.slice(prefix.length))
		.sort();
}

/** Files in this profile's storage directory, relative to it. */
async function storageFiles() {
	let root = PathUtils.join(Zotero.DataDirectory.dir, 'storage');
	let out = [];
	let walk = async (dir, rel) => {
		for (let child of await IOUtils.getChildren(dir).catch(() => [])) {
			let name = PathUtils.filename(child);
			let path = rel ? `${rel}/${name}` : name;
			let info = await IOUtils.stat(child);
			if (info.type === 'directory') {
				await walk(child, path);
			}
			else if (!name.startsWith('.zotero-')) {
				out.push(path);
			}
		}
	};
	await walk(root, '');
	return out.sort();
}

/** Anything the keep-both import left behind in the temp directory. */
async function tempCopyDirs() {
	let temp = Zotero.getTempDirectory().path;
	return (await IOUtils.getChildren(temp).catch(() => []))
		.map(child => PathUtils.filename(child))
		.filter(name => name.startsWith('zgit-copy-'));
}


async function run(step, report) {
	let plugin;
	for (let i = 0; i < 120 && !plugin; i++) {
		plugin = Zotero.GitSync?.initialized ? Zotero.GitSync : null;
		if (!plugin) {
			await sleep(500);
		}
	}
	assert(plugin, 'Git Sync plugin did not start');
	await Zotero.Libraries.userLibrary.waitForDataLoad('item');
	report.version = plugin.version;

	let env = name => Services.env.get(name);
	plugin.Prefs.set('remoteURL', env('ZGIT_REMOTE_URL'));
	plugin.Prefs.set('branch', 'main');
	plugin.Prefs.set('basePath', '');
	plugin.Prefs.set('includeGroupLibraries', false);
	plugin.Prefs.set('lfsEnabled', false);
	plugin.Prefs.set('prune', true);
	plugin.Prefs.set('authorName', 'Fixes Test');
	plugin.Prefs.set('authorEmail', 'fixes@example.com');
	let config = plugin.Prefs.getConfig();

	let sync = async (options = {}) => {
		let result = await plugin.Sync.syncNow({ trigger: `test-${step}`, ...options });
		report.result = result;
		log(`${step}: ${JSON.stringify(result)}`);
		assert(result.status !== 'error', `sync failed: ${result.error}`);
		return result;
	};

	switch (step) {
		// -- The library ---------------------------------------------------------

		case 'F1': {
			let paper = await addItem('journalArticle', 'Snapshot Paper', { date: '2024' });
			await createSnapshot(paper, 'A-first');
			let doomed = await addItem('journalArticle', 'Doomed Paper', { date: '2023' });
			let dir = PathUtils.join(Zotero.getTempDirectory().path, 'zgit-fixes-source');
			await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
			let file = PathUtils.join(dir, 'doomed.txt');
			await IOUtils.writeUTF8(file, 'doomed attachment\n');
			await Zotero.Attachments.importFromFile({ file, parentItemID: doomed.id, title: 'Doomed file' });
			await sync();
			let paths = await repoPaths(plugin, config);
			report.paths = paths;
			assert(paths.filter(p => /\/attachments\//.test(p)).length >= 4, `expected the snapshot's files in the repository: ${JSON.stringify(paths)}`);
			break;
		}

		// -- Fix 1: the prune preference -----------------------------------------

		case 'F2': {
			let doomed = await byTitle('Doomed Paper');
			assert(doomed, 'Doomed Paper is missing');
			report.doomedKey = doomed.key;
			report.doomedAttachmentKeys = doomed.getAttachments(true).map(id => Zotero.Items.get(id).key);
			plugin.Prefs.set('prune', false);
			await Zotero.Items.erase(doomed.getAttachments(true).concat(doomed.id));
			scriptReview(plugin, report);
			let result = await sync();
			let paths = await repoPaths(plugin, config);
			report.paths = paths;
			let left = paths.filter(p => p.includes(report.doomedKey) || report.doomedAttachmentKeys.some(k => p.includes(k)));
			assert(result.deleted === 0, `pruning is off, so nothing may be deleted; deleted=${result.deleted}`);
			assert(!(report.review?.incoming || []).some(t => /Doomed/.test(t)),
				`a deleted item must not be offered back as an import: ${JSON.stringify(report.review?.incoming)}`);
			assert(left.length >= 2, `the deleted item's files must stay on the server, found ${JSON.stringify(left)}`);
			report.keptOnServer = left;
			break;
		}

		case 'F3': {
			plugin.Prefs.set('prune', true);
			scriptReview(plugin, report);
			let result = await sync();
			let paths = await repoPaths(plugin, config);
			report.paths = paths;
			let doomedKeys = report.doomedKeys || JSON.parse(await IOUtils.readUTF8(PathUtils.join(Services.env.get('ZGIT_OUT'), 'doomed.json')));
			let left = paths.filter(p => doomedKeys.some(k => p.includes(k)));
			assert(!(report.review?.incoming || []).some(t => /Doomed/.test(t)),
				`the deleted item must not be offered back as an import: ${JSON.stringify(report.review?.incoming)}`);
			assert(result.deleted > 0, `pruning is on, so the deleted item must go; deleted=${result.deleted}`);
			assert(!left.length, `nothing of the deleted item may be left: ${JSON.stringify(left)}`);
			break;
		}

		// -- Fix 3: "keep both" with a multi-file attachment ----------------------

		case 'F4': {
			scriptReview(plugin, report);
			await sync();
			let files = await storageFiles();
			report.storage = files;
			for (let name of SNAPSHOT) {
				assert(files.some(f => f.endsWith(name)), `${name} did not arrive: ${JSON.stringify(files)}`);
			}
			break;
		}

		case 'F5': {
			await rewriteSnapshot('A-second');
			scriptReview(plugin, report);
			await sync();
			break;
		}

		case 'F6': {
			await rewriteSnapshot('B-edit');
			scriptReview(plugin, report, { choose: row => (/\/attachments\//.test(row.path) ? 'both' : row.choice) });
			let result = await sync();
			report.warnings = result.warnings || [];
			report.lastWarnings = plugin.Prefs.get('lastWarnings');
			let copies = (await items())
				.flatMap(item => item.getAttachments(false).map(id => Zotero.Items.get(id)))
				.filter(a => (a.getField('title') || '').includes('repository copy'))
				.map(a => a.getField('title'));
			report.copies = copies.sort();
			report.storage = await storageFiles();
			report.tempLeft = await tempCopyDirs();
			assert(copies.length === SNAPSHOT.length,
				`every file of the snapshot must be kept, got ${copies.length}: ${JSON.stringify(copies)} / warnings ${JSON.stringify(report.lastWarnings)}`);
			assert(!report.tempLeft.length, `the temporary folder must be gone: ${JSON.stringify(report.tempLeft)}`);
			break;
		}

		// -- Fix 2: a repository path that leaves the attachment folder -----------

		case 'F7': {
			let before = await storageFiles();
			let result = await plugin.Sync.pull({ confirm: false });
			report.result = result;
			assert(result.status !== 'error', `import failed: ${result.error}`);
			let after = await storageFiles();
			report.storage = after;
			report.warnings = plugin.Prefs.get('lastWarnings');
			report.newFiles = after.filter(f => !before.includes(f));
			let escaped = report.newFiles.filter(f => /escape\.txt$/.test(f) || f.split('/').length < 2);
			assert(!escaped.length, `a file was written outside its attachment folder: ${JSON.stringify(escaped)}`);
			assert(/leaves the attachment folder/.test(JSON.stringify(report.warnings || [])),
				`the bad path must be reported, warnings were ${JSON.stringify(report.warnings)}`);
			report.safeSegments = {
				good: plugin.Importer.safeSegments('page/style.css'),
				dotdot: plugin.Importer.safeSegments('../escape.txt'),
				dot: plugin.Importer.safeSegments('./x'),
				empty: plugin.Importer.safeSegments('a//b'),
			};
			assert(report.safeSegments.dotdot === null && report.safeSegments.dot === null && report.safeSegments.empty === null,
				`safeSegments accepted a bad path: ${JSON.stringify(report.safeSegments)}`);
			break;
		}

		default:
			throw new Error(`Unknown step ${step}`);
	}

	if (step === 'F2') {
		await IOUtils.writeJSON(PathUtils.join(Services.env.get('ZGIT_OUT'), 'doomed.json'),
			[report.doomedKey, ...report.doomedAttachmentKeys]);
	}
	report.repoPaths = await repoPaths(plugin, config);
}
