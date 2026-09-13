/* Zotero Git Sync -- two-computer sync test
 *
 * DEVELOPMENT ONLY. Two throwaway profiles, A and B, take turns syncing the same
 * throwaway repository (see scripts/conflict-test/run-remote.sh), and a third,
 * C, imports the result into an empty library. Each Zotero
 * launch runs one step, named by ZGIT_STEP, then writes ZGIT_OUT/<step>.json and
 * quits. The review panel is replaced by a scripted chooser, so the decisions a
 * person would click are made the same way every run.
 *
 * Steps, in order:
 *   A1  A creates a small library and syncs into the empty repository
 *   B1  B starts empty and syncs: everything arrives as incoming, accepted
 *   A2  A retitles BERT, trashes Deep Learning, adds Mask R-CNN, syncs
 *   B2  B, still behind, retitles BERT differently and adds a note to
 *       Attention, then runs a background sync: its own safe change must go
 *       up, nothing of A's may be deleted or overwritten
 *   B3  B syncs with a review: BERT takes the repository's version, Mask
 *       R-CNN is imported, Deep Learning (deleted there) is not uploaded again
 *   A3  A syncs with a review and accepts B's note
 *   C1  C, an empty profile, runs Import from Git; its attachment files must
 *       be byte-identical to A's (ZGIT_LFS=1 puts the large one in Git LFS)
 *
 * With ZGIT_TOKEN_FILE and ZGIT_HTTPS_USER the steps sign in to an HTTPS
 * remote with a token, and the optional step X0 (profile C, before C1) first
 * checks that a sync without the token fails with a readable message.
 */

var log = msg => Zotero.debug(`[ZGIT two-computer test] ${msg}`);
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


var MINIMAL_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 58>>stream
BT /F1 24 Tf 72 700 Td (Attention Is All You Need) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;


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


async function createLibrary() {
	let attention = await addItem('conferencePaper', 'Attention Is All You Need', { date: '2017' });
	await addItem('journalArticle', 'BERT: Pre-training of Deep Bidirectional Transformers', { date: '2019' });
	let resnet = await addItem('conferencePaper', 'Deep Residual Learning for Image Recognition', { date: '2016' });
	await addItem('journalArticle', 'ImageNet Classification with Deep Convolutional Neural Networks', { date: '2017' });
	await addItem('book', 'Deep Learning', { date: '2016' });

	let dir = PathUtils.join(Zotero.getTempDirectory().path, 'zgit-two-computer');
	await IOUtils.makeDirectory(dir, { ignoreExisting: true });
	let path = PathUtils.join(dir, 'vaswani-2017.pdf');
	await IOUtils.writeUTF8(path, MINIMAL_PDF);
	let attachment = await Zotero.Attachments.importFromFile({ file: path, parentItemID: attention.id, title: 'Full Text PDF' });

	// Over the 1 MB LFS threshold the test sets: goes to Git LFS when enabled
	let data = new Uint8Array(1536 * 1024 + 7);
	for (let i = 0; i < data.length; i++) {
		data[i] = (i * 2654435761) >>> 24;
	}
	let supplement = PathUtils.join(dir, 'resnet-supplement.bin');
	await IOUtils.write(supplement, data);
	await Zotero.Attachments.importFromFile({ file: supplement, parentItemID: resnet.id, title: 'Supplementary data' });
	await Zotero.Annotations.saveFromJSON(attachment, {
		key: Zotero.DataObjectUtilities.generateKey(),
		type: 'highlight',
		text: 'Attention Is All You Need',
		comment: 'Thesis',
		color: '#ffd400',
		pageLabel: '1',
		sortIndex: '00000|000700|00072',
		position: { pageIndex: 0, rects: [[72, 700, 360, 724]] },
	});
}


/**
 * Stand in for the review panel. `script` picks, per row, what a person would.
 */
function scriptReview(plugin, report, script = {}) {
	plugin.Review.ask = async (review) => {
		report.review = {
			incoming: review.incoming.map(r => r.title),
			conflicts: review.conflicts.map(r => ({ title: r.title, options: r.options, default: r.choice })),
			overwrite: review.overwrite.map(r => r.title),
			restore: review.restore.map(r => r.title),
			server: review.server.map(r => `${r.action}: ${r.title}`),
			counts: review.counts,
		};
		let checks = { incoming: new Map(), overwrite: new Map(), restore: new Map(), server: new Map() };
		let choices = new Map();
		for (let row of review.incoming) {
			checks.incoming.set(row.path, script.accept ? script.accept(row) : true);
		}
		for (let row of review.conflicts) {
			choices.set(row.path, script.choose ? script.choose(row) : row.choice);
		}
		for (let row of review.overwrite) {
			checks.overwrite.set(row.path, true);
		}
		for (let row of review.restore) {
			checks.restore.set(row.path, script.restore ? script.restore(row) : true);
		}
		for (let row of review.server) {
			checks.server.set(row.path, true);
		}
		return plugin.Review._decisions(review, checks, choices);
	};
}


async function storageHashes() {
	let root = PathUtils.join(Zotero.DataDirectory.dir, 'storage');
	let out = {};
	let walk = async (dir, rel) => {
		for (let child of await IOUtils.getChildren(dir).catch(() => [])) {
			let name = PathUtils.filename(child);
			let info = await IOUtils.stat(child);
			let path = rel ? `${rel}/${name}` : name;
			if (info.type === 'directory') {
				await walk(child, path);
			}
			else if (!name.startsWith('.zotero-')) {
				let digest = await crypto.subtle.digest('SHA-256', await IOUtils.read(child));
				out[path] = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
			}
		}
	};
	await walk(root, '');
	return out;
}


async function snapshot(plugin, config) {
	let lib = [];
	for (let item of await items()) {
		lib.push({
			title: item.getField('title'),
			key: item.key,
			notes: item.isRegularItem() ? item.getNotes(false).length : 0,
			attachments: item.isRegularItem() ? item.getAttachments(false).length : 0,
		});
	}
	lib.sort((a, b) => (a.title < b.title ? -1 : 1));

	let git = await plugin.Sync.openRepository(config);
	let head = await git.fetch();
	let repo = { head, items: [], files: [], author: null };
	if (head) {
		repo.author = (await git.run(['log', '-1', '--format=%an <%ae>', head])).stdout.trim();
		repo.commits = Number((await git.run(['rev-list', '--count', head])).stdout.trim());
		let tree = await git.listTree(head);
		let prefix = config.basePath ? `${config.basePath}/` : '';
		let itemPaths = [];
		for (let [path, entry] of tree) {
			if (prefix && !path.startsWith(prefix)) {
				continue;
			}
			let item = path.match(/\/items\/[A-Z0-9]{2}\/([A-Z0-9]{8})\.json$/);
			if (item) {
				itemPaths.push({ key: item[1], sha: entry.sha });
			}
			else if (/\/attachments(-lfs)?\//.test(path)) {
				repo.files.push(path.replace(/^.*\/attachments/, 'attachments'));
			}
		}
		let blobs = await git.readBlobs(itemPaths.map(p => p.sha));
		for (let { key, sha } of itemPaths) {
			let record = JSON.parse(plugin.Utils.textDecoder.decode(blobs.get(sha)));
			repo.items.push({
				title: record.zotero.title,
				key,
				children: (record.children || []).map(c => c.itemType).sort(),
			});
		}
		repo.items.sort((a, b) => (a.title < b.title ? -1 : 1));
	}
	let state = await plugin.State.load(config);
	return { library: lib, repo, basePaths: state ? state.base.size : 0, storage: await storageHashes() };
}


async function run(step, report) {
	let plugin;
	for (let i = 0; i < 120 && !plugin; i++) {
		plugin = Zotero.GitSync?.initialized ? Zotero.GitSync : null;
		if (!plugin) {
			await sleep(500);
		}
	}
	if (!plugin) {
		throw new Error('Git Sync plugin did not start');
	}
	await Zotero.Libraries.userLibrary.waitForDataLoad('item');

	let env = name => Services.env.get(name);
	plugin.Prefs.set('remoteURL', env('ZGIT_REMOTE_URL'));
	plugin.Prefs.set('branch', 'main');
	plugin.Prefs.set('basePath', env('ZGIT_BASE_PATH') || '');
	plugin.Prefs.set('includeGroupLibraries', false);
	plugin.Prefs.set('lfsEnabled', env('ZGIT_LFS') === '1');
	plugin.Prefs.set('lfsThresholdMB', 1);
	if (step.startsWith('A')) {
		// A names its commits; B relies on git's own identity or the fallback
		plugin.Prefs.set('authorName', 'Computer A');
		plugin.Prefs.set('authorEmail', 'a@example.com');
	}
	let tokenFile = env('ZGIT_TOKEN_FILE');
	if (tokenFile && step !== 'X0') {
		plugin.Prefs.set('httpsUsername', env('ZGIT_HTTPS_USER') || '');
		await plugin.Prefs.setToken((await IOUtils.readUTF8(tokenFile)).trim());
	}
	let config = plugin.Prefs.getConfig();
	report.git = await plugin.Git.versions(await plugin.Git.find());

	let sync = async (options) => {
		let result = await plugin.Sync.syncNow({ trigger: `test-${step}`, ...options });
		report.result = result;
		log(`${step}: ${JSON.stringify(result)}`);
		if (result.status === 'error') {
			throw new Error(result.error);
		}
		return result;
	};

	switch (step) {
		case 'A1':
			await createLibrary();
			await sync({});
			break;

		case 'B1':
			scriptReview(plugin, report);
			await sync({});
			break;

		case 'A2': {
			let bert = await byTitle('BERT');
			bert.setField('title', 'BERT: Pre-training of Deep Bidirectional Transformers (A revised)');
			await bert.saveTx();
			let book = await byTitle('Deep Learning');
			book.deleted = true;
			await book.saveTx();
			await addItem('conferencePaper', 'Mask R-CNN', { date: '2017' });
			scriptReview(plugin, report);
			await sync({});
			break;
		}

		case 'B2': {
			let bert = await byTitle('BERT');
			bert.setField('title', 'BERT: Pre-training of Deep Bidirectional Transformers (B edit)');
			await bert.saveTx();
			let attention = await byTitle('Attention');
			let note = new Zotero.Item('note');
			note.libraryID = libraryID();
			note.parentID = attention.id;
			note.setNote('<p>Note written on computer B</p>');
			await note.saveTx();
			plugin.Review.ask = async () => {
				throw new Error('A background sync must not open the review');
			};
			await sync({ silent: true });
			break;
		}

		case 'B3':
			scriptReview(plugin, report, {
				choose: row => (row.title.startsWith('BERT') ? 'server' : row.choice),
				restore: () => false,
			});
			await sync({});
			break;

		case 'A3':
			scriptReview(plugin, report);
			await sync({});
			break;

		case 'X0': {
			await plugin.Prefs.setToken('');
			let result = await plugin.Sync.syncNow({ trigger: 'test-X0', silent: true });
			report.result = result;
			if (result.status !== 'error' || !/credentials/i.test(result.error)) {
				throw new Error(`Expected a credentials error, got ${JSON.stringify(result)}`);
			}
			report.after = { message: result.error };
			return;
		}

		case 'C1': {
			let result = await plugin.Sync.pull({ confirm: false });
			report.result = result;
			log(`${step}: ${JSON.stringify(result)}`);
			if (result.status === 'error') {
				throw new Error(result.error);
			}
			report.lastWarnings = plugin.Prefs.get('lastWarnings');
			break;
		}

		default:
			throw new Error(`Unknown step ${step}`);
	}

	report.after = await snapshot(plugin, config);
}
