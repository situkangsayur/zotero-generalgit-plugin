// src/git.js against the real git, under Node. Needs git; the Git LFS part
// needs git-lfs on PATH and is skipped without it. Run with `npm run test:git`.
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { install } from './shim.mjs';

install();
const SRC = new URL('../src', import.meta.url).pathname;
globalThis.ZoteroGitSync = { log: process.env.DEBUG ? m => console.log('  ', m) : () => {}, warn() {}, logError: console.error, getString: k => k };
for (const f of ['utils.js', 'files.js', 'git.js']) {
	vm.runInThisContext(readFileSync(`${SRC}/${f}`, 'utf8'));
}
const { Git, Repository, GitError, Utils, CancelToken } = ZoteroGitSync;

const tmp = mkdtempSync(path.join(os.tmpdir(), 'zgit-test-'));
const sh = (args, cwd = tmp) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } });
const blobSha = bytes => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), Buffer.from(bytes)])).digest('hex');

try {
	const gitPath = await Git.find();
	const versions = await Git.versions(gitPath);
	console.log(versions.git, '|', versions.lfs || 'no git-lfs');

	sh(['init', '--bare', '-q', 'remote.git']);
	const remoteURL = `file://${tmp}/remote.git`;
	const author = { name: 'Zotero Test', email: 'test@example.com' };
	const repo = (dir, extra = {}) => new Repository({ gitPath, gitDir: path.join(tmp, dir), remoteURL, branch: 'main', author, ...extra });

	// -- An empty remote ----------------------------------------------------
	const a = repo('a.git');
	await a.init();
	await a.init(); // idempotent
	assert.equal(await a.fetch(), null, 'empty remote has no branch');
	assert.deepEqual([...(await a.listRemoteBranches())], []);

	// -- First commit: text via fast-import, a file via hash-object --------------
	const texts = [
		{ path: 'zotero/my-library/items/AB/ABCD1234.json', bytes: Utils.encode('{"title":"Attention"}\n') },
		{ path: 'zotero/my-library/notes/A/Tab\there (ABCD1234).md', bytes: Utils.encode('# note ünïcode\n') },
		{ path: 'zotero/README.md', bytes: new Uint8Array(0) },
	];
	for (const t of texts) {
		t.sha = await Utils.gitBlobSha(t.bytes);
	}
	await a.writeTextBlobs(texts);
	const pdf = path.join(tmp, 'paper.pdf');
	const pdfBytes = randomBytes(300 * 1024);
	writeFileSync(pdf, pdfBytes);
	const pdfSha = blobSha(pdfBytes);
	await a.writeFileBlobs([{ path: pdf, sha: pdfSha }]);
	await assert.rejects(a.writeFileBlobs([{ path: pdf, sha: 'f'.repeat(40) }]), /changed during sync/);
	assert.deepEqual(await a.missingObjects([pdfSha, texts[0].sha, 'e'.repeat(40)]), ['e'.repeat(40)]);

	const entries = [...texts.map(t => ({ path: t.path, sha: t.sha })), { path: 'zotero/my-library/attachments/PD/PDF00001/paper.pdf', sha: pdfSha }];
	const tree1 = await a.buildTree(null, entries);
	const c1 = await a.commitTree({ tree: tree1, parents: [], message: 'Zotero sync: 4 added' });
	await a.push(c1);
	assert.equal(sh(['--git-dir=remote.git', 'rev-parse', 'main']).trim(), c1);
	assert.match(sh(['--git-dir=remote.git', 'log', '-1', '--format=%an <%ae>|%s', 'main']), /^Zotero Test <test@example.com>\|Zotero sync: 4 added/);

	const listed = await a.listTree(c1);
	assert.equal(listed.size, 4);
	assert.equal(listed.get('zotero/my-library/notes/A/Tab\there (ABCD1234).md').sha, texts[1].sha, 'tab in a path survives -z');
	assert.equal(listed.get('zotero/my-library/attachments/PD/PDF00001/paper.pdf').size, pdfBytes.length);

	// -- Second computer: fetch, read back, change, delete ------------------------
	const b = repo('b.git');
	await b.init();
	const head = await b.fetch();
	assert.equal(head, c1);
	const blobs = await b.readBlobs([texts[0].sha, texts[1].sha, texts[2].sha, 'd'.repeat(40), texts[0].sha]);
	assert.equal(blobs.size, 3);
	assert.equal(Utils.textDecoder.decode(blobs.get(texts[1].sha)), '# note ünïcode\n');
	assert.equal(blobs.get(texts[2].sha).length, 0, 'empty blob');
	const restored = path.join(tmp, 'restored', 'paper.pdf');
	assert.equal(await b.downloadBlob(pdfSha, restored), pdfBytes.length);
	assert.ok(Buffer.from(readFileSync(restored)).equals(pdfBytes));

	const edited = { bytes: Utils.encode('{"title":"Attention Is All You Need"}\n') };
	edited.sha = await Utils.gitBlobSha(edited.bytes);
	await b.writeTextBlobs([edited]);
	const tree2 = await b.buildTree(head, [
		{ path: texts[0].path, sha: edited.sha },
		{ path: 'zotero/my-library/attachments/PD/PDF00001/paper.pdf', sha: null },
	]);
	const c2 = await b.commitTree({ tree: tree2, parents: [head], message: 'B edits' });
	await b.push(c2);
	const afterB = await b.listTree(c2);
	assert.equal(afterB.size, 3);
	assert.equal(afterB.get(texts[0].path).sha, edited.sha);

	// -- A is now behind: its push must be refused with branchMoved ---------------
	const tree3 = await a.buildTree(c1, [{ path: 'zotero/other.json', sha: texts[0].sha }]);
	const c3 = await a.commitTree({ tree: tree3, parents: [c1], message: 'A, behind' });
	await assert.rejects(a.push(c3), e => e instanceof GitError && e.branchMoved === true);
	assert.equal(await a.fetch(), c2, 'fetch catches up');

	// -- Errors people will actually hit ------------------------------------------
	const missing = new Repository({ gitPath, gitDir: path.join(tmp, 'm.git'), remoteURL: `file://${tmp}/nope.git`, branch: 'main' });
	await missing.init();
	await assert.rejects(missing.fetch(), e => e instanceof GitError && /not found|does not appear/i.test(e.message));
	assert.match(Git.explain("git@gitlab.com: Permission denied (publickey).\nfatal: Could not read from remote repository."), /SSH key/);
	assert.match(Git.explain('fatal: unable to access https://u:secret@h/x.git/: The requested URL returned error: 403'), /HTTPS credentials/);
	assert.doesNotMatch(Git.explain('fatal: unable to access https://u:secret@h/x.git/: The requested URL returned error: 403'), /secret/);
	assert.match(Git.explain("git: 'lfs' is not a git command. See 'git --help'."), /Git LFS is not installed/);

	// -- HTTPS token goes in the environment, scoped to the remote's origin -----
	const withToken = new Repository({ gitPath, gitDir: null, remoteURL: 'https://gitea.example.com:3000/me/lib.git', httpsUsername: 'me', token: 's3cret' });
	const env = withToken._environment();
	assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://gitea.example.com:3000/.extraHeader');
	assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from('me:s3cret').toString('base64')}`);
	assert.equal(env.GIT_TERMINAL_PROMPT, '0');
	const sshRepo = new Repository({ gitPath, gitDir: null, remoteURL: 'git@gitlab.com:me/lib.git', token: 's3cret' });
	assert.equal(sshRepo._environment().GIT_CONFIG_COUNT, undefined, 'no header for SSH remotes');

	// -- Cancelling kills a running git ----------------------------------------------
	const cancel = new CancelToken();
	const slow = new Repository({ gitPath, gitDir: path.join(tmp, 'a.git'), remoteURL, cancel });
	const t0 = Date.now();
	setTimeout(() => cancel.cancel(), 150);
	await assert.rejects(slow.run(['cat-file', '--batch'], { input: async (write) => {
		await write(`${texts[0].sha}\n`);
		await new Promise(resolve => setTimeout(resolve, 5000));
	} }), e => e.name === 'CancelledError');
	assert.ok(Date.now() - t0 < 3000, 'cancel took effect quickly');

	// -- Large text batch through fast-import -----------------------------------
	const many = [];
	for (let i = 0; i < 3000; i++) {
		const bytes = Utils.encode(`{"i":${i},"pad":"${'x'.repeat(i % 700)}"}\n`);
		many.push({ bytes, sha: await Utils.gitBlobSha(bytes) });
	}
	await a.writeTextBlobs(many);
	const readMany = await a.readBlobs(many.map(m => m.sha));
	assert.equal(readMany.size, 3000);
	assert.ok(many.every(m => Buffer.from(readMany.get(m.sha)).equals(Buffer.from(m.bytes))));

	// -- Git LFS --------------------------------------------------------------------
	if (versions.lfs) {
		const big = path.join(tmp, 'book.pdf');
		const bigBytes = randomBytes(2 * 1024 * 1024 + 17);
		writeFileSync(big, bigBytes);
		const oid = createHash('sha256').update(bigBytes).digest('hex');
		assert.ok(await b.lfsAvailable());
		let progress = [];
		await b.lfsUpload([{ oid, size: bigBytes.length, path: big }], { onProgress: (d, t) => progress.push([d, t]) });
		assert.deepEqual(progress.at(-1), [1, 1]);
		const media = await b.lfsMediaDir();
		assert.equal(await IOUtils.exists(path.join(media, oid.slice(0, 2), oid.slice(2, 4), oid)), false, 'staged copy removed after upload');

		const pointer = Utils.lfsPointer(oid, bigBytes.length);
		const pointerBlob = { bytes: Utils.encode(pointer) };
		pointerBlob.sha = await Utils.gitBlobSha(pointerBlob.bytes);
		await b.writeTextBlobs([pointerBlob]);
		const lfsPath = 'zotero/my-library/attachments-lfs/BO/BOOK0001/book.pdf';
		const tree4 = await b.buildTree(c2, [{ path: lfsPath, sha: pointerBlob.sha }]);
		const c4 = await b.commitTree({ tree: tree4, parents: [c2], message: 'LFS' });
		await b.push(c4);

		const c = repo('c.git');
		await c.init();
		assert.equal(await c.fetch(), c4);
		const text = await c.getBlobText((await c.listTree(c4)).get(lfsPath).sha);
		const out = path.join(tmp, 'restored', 'book.pdf');
		assert.equal(await c.lfsDownload(text, out, lfsPath), bigBytes.length);
		assert.ok(Buffer.from(readFileSync(out)).equals(bigBytes));
		await assert.rejects(c.lfsDownload(Utils.lfsPointer('0'.repeat(64), 5), path.join(tmp, 'restored', 'nope.pdf'), 'x.pdf'));
		assert.equal(await IOUtils.exists(path.join(tmp, 'restored', 'nope.pdf')), false);
	}
	console.log('all git tests passed');
}
finally {
	rmSync(tmp, { recursive: true, force: true });
}
