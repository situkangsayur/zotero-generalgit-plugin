/* Zotero Git Sync -- the git installed on this computer
 *
 * Everything that touches a repository goes through the `git` (and `git lfs`)
 * command-line tools, run with Firefox's Subprocess module. Authentication is
 * whatever git already uses on this computer -- SSH keys and agent, or an HTTPS
 * credential helper -- so any host that git can talk to works.
 *
 * The local copy is a *bare* repository: there is no working tree, because the
 * files are already on disk in Zotero's storage directory. Commits are built
 * with plumbing commands, the way Zotero GitHub Sync builds them with GitHub's
 * Git Data API:
 *
 *   text files        git fast-import         (one process for the whole batch)
 *   attachment files  git hash-object -w      (git reads them straight from storage)
 *   trees             git update-index + write-tree, on a private index file
 *   commits           git commit-tree
 *   publishing        git push, refused by the server if the branch moved
 *
 * so the attachments exist on disk twice (storage and the compressed object
 * database) rather than three times (storage, a checkout, and the objects).
 */

ZoteroGitSync.GitError = class GitError extends Error {
	constructor(message, { args = [], exitCode = null, stderr = '', branchMoved = false } = {}) {
		super(message);
		this.name = 'GitError';
		this.args = args;
		this.exitCode = exitCode;
		this.stderr = stderr;
		this.branchMoved = branchMoved;
	}
};


ZoteroGitSync.Git = {
	// Where git lives when a GUI application doesn't inherit the login shell's
	// PATH (macOS in particular), plus the usual Git for Windows locations
	EXTRA_DIRS_UNIX: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/opt/local/bin', '/snap/bin'],

	_subprocess: null,


	get Subprocess() {
		if (!this._subprocess) {
			this._subprocess = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs').Subprocess;
		}
		return this._subprocess;
	},


	get isWindows() {
		return !!Zotero.isWin;
	},


	_windowsDirs() {
		let env = this.Subprocess.getEnvironment();
		let dirs = [];
		for (let root of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Programs`]) {
			if (root) {
				dirs.push(`${root}\\Git\\cmd`);
			}
		}
		return dirs;
	},


	/**
	 * @return {String} PATH for git and the tools it runs (ssh, git-lfs,
	 * 		credential helpers), with the usual install locations appended
	 */
	searchPath(gitPath = null) {
		let env = this.Subprocess.getEnvironment();
		let sep = this.isWindows ? ';' : ':';
		let dirs = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
		let extra = this.isWindows ? this._windowsDirs() : this.EXTRA_DIRS_UNIX;
		if (gitPath) {
			extra = [PathUtils.parent(gitPath), ...extra];
		}
		for (let dir of extra) {
			if (!dirs.includes(dir)) {
				dirs.push(dir);
			}
		}
		return dirs.join(sep);
	},


	/**
	 * @param {String} [configured] - Path from the settings, if any
	 * @return {Promise<String>} Absolute path of the git executable
	 */
	async find(configured = '') {
		if (configured) {
			if (await IOUtils.exists(configured)) {
				return configured;
			}
			throw new ZoteroGitSync.GitError(`git was not found at ${configured} (Settings → Git Sync → Advanced).`);
		}
		try {
			return await this.Subprocess.pathSearch(this.isWindows ? 'git.exe' : 'git', { PATH: this.searchPath() });
		}
		catch (e) {
			throw new ZoteroGitSync.GitError(
				this.isWindows
					? 'git was not found. Install Git for Windows (https://git-scm.com/download/win), then restart Zotero.'
					: 'git was not found. Install git (and git-lfs for large files), then restart Zotero, '
						+ 'or set its location in Settings → Git Sync → Advanced.'
			);
		}
	},


	/**
	 * Run git once, outside any repository.
	 *
	 * @return {Promise<Object>} As Repository#run()
	 */
	async run(gitPath, args, options = {}) {
		let repo = new ZoteroGitSync.Repository({ gitPath, gitDir: null });
		return repo.run(args, options);
	},


	/**
	 * @return {Promise<{git: String, lfs: String|null}>} Version strings
	 */
	async versions(gitPath) {
		let git = (await this.run(gitPath, ['version'])).stdout.trim();
		let lfs = null;
		try {
			lfs = (await this.run(gitPath, ['lfs', 'version'], { timeout: 30000 })).stdout.trim() || null;
		}
		catch (e) {
			// Not installed
		}
		return { git, lfs };
	},


	/**
	 * Turn git's stderr into something a person can act on. The raw output is
	 * kept on the error and in the debug log.
	 *
	 * @param {String} stderr
	 * @param {String[]} args
	 * @param {Object} [context]
	 * @param {String|null} [context.tokenUser] - Set when a stored HTTPS token was sent
	 * @return {String}
	 */
	explain(stderr, args = [], { tokenUser = null } = {}) {
		let text = ZoteroGitSync.Utils.redactURLs(stderr || '');
		let has = re => re.test(text);
		let hint = '';
		if (has(/git: 'lfs' is not a git command|git-lfs.*not found/i)) {
			hint = 'Git LFS is not installed. Install git-lfs (https://git-lfs.com), or turn off "Store files larger than … with Git LFS" in Settings → Git Sync.';
		}
		else if (has(/Host key verification failed/i)) {
			hint = 'SSH does not know this server yet. Connect once from a terminal (for example: ssh -T git@your-host) '
				+ 'and accept its host key, then sync again.';
		}
		else if (has(/Permission denied \(publickey|no such identity|agent refused operation/i)) {
			hint = 'The server did not accept an SSH key. Add your public key to your account on the Git host, '
				+ 'and make sure the key is loaded in your SSH agent (a key with a passphrase needs the agent).';
		}
		else if (has(/terminal prompts disabled|could not read (Username|Password)|Authentication failed|HTTP Basic: Access denied|The requested URL returned error: 40[13]|invalid credentials|Unauthorized/i)) {
			hint = tokenUser !== null
				? `The server rejected the access token saved in Settings → Git Sync (sent with user name "${tokenUser}"). `
					+ 'Check that the token was copied completely and hasn\'t expired or been deleted on the host, that it '
					+ 'can read and write repositories, and that the user name is right -- then save it again.'
				: 'The server refused the HTTPS credentials. Set up a Git credential helper, or enter a user name '
					+ 'and access token in Settings → Git Sync.';
		}
		else if (has(/Repository not found|does not appear to be a git repository|project you were looking for could not be found|The requested URL returned error: 404|repository .* not found/i)) {
			hint = 'The repository was not found, or this account cannot see it. Check the repository address, '
				+ 'and create the repository on the host first -- the plugin can\'t create it for you.';
		}
		else if (has(/Could not resolve host|Connection timed out|Network is unreachable|Connection refused|Failed to connect/i)) {
			hint = 'Could not reach the Git server. Check the network connection and the repository address.';
		}
		else if (has(/exceeds.*(file size|limit)|File size limit|larger than|GH001|too large|Payload Too Large|HTTP 413|repository size limit|quota|storage limit/i)) {
			hint = 'The Git host refused the push because of a size limit or quota. Lower "Store files larger than" '
				+ 'for Git LFS, skip very large attachments, or check the repository\'s storage limits on the host.';
		}
		else if (has(/pre-receive hook declined|protected branch|not allowed to push|You are not allowed/i)) {
			hint = 'The server refused the push. The branch may be protected, or this account may lack write access.';
		}
		let lines = text.split('\n')
			.map(line => line.replace(/\r.*$/, '').trim())
			.filter(line => line && !/^(Enumerating|Counting|Compressing|Writing|Total|Delta|Receiving|Resolving|remote: (Counting|Compressing|Enumerating|Total))/i.test(line));
		let detail = lines.slice(-4).join(' ');
		let command = args.find(arg => !arg.startsWith('-'));
		let label = command ? `git ${command}` : 'git';
		if (hint) {
			return detail ? `${hint}\n(${label}: ${detail})` : hint;
		}
		return `${label} failed${detail ? `: ${detail}` : ''}`;
	},
};


/**
 * Reads a Subprocess pipe as a byte stream: whole chunks, lines, or exactly
 * n bytes, which is what parsing `git cat-file --batch` needs.
 */
ZoteroGitSync.PipeReader = class PipeReader {
	constructor(pipe, onChunk = null) {
		this.pipe = pipe;
		this.onChunk = onChunk;
		this.chunks = [];
		this.available = 0;
		this.eof = false;
	}


	async _fill() {
		if (this.eof) {
			return false;
		}
		let buffer = await this.pipe.read();
		if (!buffer.byteLength) {
			this.eof = true;
			return false;
		}
		this.onChunk?.();
		this.chunks.push(new Uint8Array(buffer));
		this.available += buffer.byteLength;
		return true;
	}


	/**
	 * @return {Promise<Uint8Array|null>} The next chunk as it arrives, or null at the end
	 */
	async chunk() {
		if (!this.chunks.length && !await this._fill()) {
			return null;
		}
		let chunk = this.chunks.shift();
		this.available -= chunk.length;
		return chunk;
	}


	/**
	 * @param {Number} n
	 * @return {Promise<Uint8Array>} Fewer than n bytes only at the end of the stream
	 */
	async take(n) {
		while (this.available < n && await this._fill()) {}
		let size = Math.min(n, this.available);
		let out = new Uint8Array(size);
		let offset = 0;
		while (offset < size) {
			let chunk = this.chunks[0];
			let part = Math.min(chunk.length, size - offset);
			out.set(chunk.subarray(0, part), offset);
			offset += part;
			if (part === chunk.length) {
				this.chunks.shift();
			}
			else {
				this.chunks[0] = chunk.subarray(part);
			}
		}
		this.available -= size;
		return out;
	}


	/**
	 * @return {Promise<String|null>} One line without its newline, or null at the end
	 */
	async line() {
		while (true) {
			let offset = 0;
			for (let chunk of this.chunks) {
				let index = chunk.indexOf(10);
				if (index !== -1) {
					let bytes = await this.take(offset + index + 1);
					return ZoteroGitSync.Utils.textDecoder.decode(bytes.subarray(0, bytes.length - 1));
				}
				offset += chunk.length;
			}
			if (!await this._fill()) {
				if (!this.available) {
					return null;
				}
				return ZoteroGitSync.Utils.textDecoder.decode(await this.take(this.available));
			}
		}
	}


	/**
	 * @return {Promise<Uint8Array>} Everything left in the stream
	 */
	async rest() {
		while (await this._fill()) {}
		return this.take(this.available);
	}
};


ZoteroGitSync.Repository = class Repository {
	static EMPTY_SHA = '0000000000000000000000000000000000000000';
	// A network command that prints nothing for this long is stuck -- usually
	// waiting for a password prompt that can never be shown
	static NETWORK_IDLE_MS = 3 * 60 * 1000;
	static LFS_BATCH = 100;


	/**
	 * @param {Object} options
	 * @param {String} options.gitPath
	 * @param {String|null} options.gitDir - The bare repository; null to run git outside one
	 * @param {String} [options.remoteURL]
	 * @param {String} [options.branch]
	 * @param {String} [options.httpsUsername]
	 * @param {String} [options.token] - Sent only to the remote's own HTTPS origin
	 * @param {Object} [options.author] - { name, email }
	 * @param {ZoteroGitSync.CancelToken} [options.cancel]
	 */
	constructor({ gitPath, gitDir, remoteURL = '', branch = 'main', httpsUsername = '', token = '', author = null, cancel = null }) {
		this.gitPath = gitPath;
		this.gitDir = gitDir;
		this.remoteURL = remoteURL;
		this.branch = branch;
		this.httpsUsername = httpsUsername;
		this.token = token;
		this.author = author;
		this.cancel = cancel;
		this._lfsMediaDir = null;
	}


	get trackingRef() {
		return `refs/remotes/origin/${this.branch}`;
	}


	/**
	 * @return {Boolean} Whether a stored token goes with requests to this remote
	 */
	get sendsToken() {
		let parts = ZoteroGitSync.Utils.parseRemoteURL(this.remoteURL);
		return !!(this.token && parts && (parts.scheme === 'https' || parts.scheme === 'http'));
	}


	_explain(stderr, args) {
		return ZoteroGitSync.Git.explain(stderr, args, { tokenUser: this.sendsToken ? (this.httpsUsername || 'oauth2') : null });
	}


	/**
	 * @return {Object} Environment added to git's own
	 */
	_environment() {
		let env = {
			PATH: ZoteroGitSync.Git.searchPath(this.gitPath),
			// Never wait for a password on a terminal nobody can see
			GIT_TERMINAL_PROMPT: '0',
			GCM_INTERACTIVE: 'never',
			// Messages git prints in English, whatever the system language, so
			// explain() can recognise them
			LANGUAGE: 'en',
			GIT_ASK_YESNO: 'false',
		};
		let config = [];
		if (this.token) {
			let parts = ZoteroGitSync.Utils.parseRemoteURL(this.remoteURL);
			if (parts && (parts.scheme === 'https' || parts.scheme === 'http')) {
				let origin = `${parts.scheme}://${parts.host}${parts.port ? `:${parts.port}` : ''}/`;
				let credentials = ZoteroGitSync.Utils.toBase64(
					ZoteroGitSync.Utils.encode(`${this.httpsUsername || 'oauth2'}:${this.token}`)
				);
				// In the environment rather than on the command line, where other
				// users of the computer could read it; scoped to the remote's own
				// origin so it never travels to an LFS storage redirect
				config.push([`http.${origin}.extraHeader`, `Authorization: Basic ${credentials}`]);
			}
		}
		if (this.author?.name && this.author?.email) {
			env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = this.author.name;
			env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = this.author.email;
		}
		if (config.length) {
			env.GIT_CONFIG_COUNT = String(config.length);
			config.forEach(([key, value], i) => {
				env[`GIT_CONFIG_KEY_${i}`] = key;
				env[`GIT_CONFIG_VALUE_${i}`] = value;
			});
		}
		return env;
	}


	/**
	 * Run a git command.
	 *
	 * @param {String[]} args - Arguments after `git`
	 * @param {Object} [options]
	 * @param {String|Uint8Array|Function} [options.input] - Written to stdin, or
	 * 		async (write) => {} to stream it
	 * @param {Function} [options.consume] - async (PipeReader) => result, to read
	 * 		stdout as a stream instead of collecting it
	 * @param {Number[]} [options.okExitCodes=[0]]
	 * @param {Boolean} [options.network] - Kill the command when it goes quiet
	 * 		for too long instead of applying a fixed timeout
	 * @param {Number} [options.timeout=600000] - Milliseconds, for local commands
	 * @param {Function} [options.onStderr] - Called with each piece of stderr
	 * @param {Object} [options.env] - Extra environment variables for this command
	 * @return {Promise<{stdout: String, stdoutBytes: Uint8Array, stderr: String, exitCode: Number, result: *}>}
	 */
	async run(args, { input = null, consume = null, okExitCodes = [0], network = false, timeout = 10 * 60 * 1000, onStderr = null, env = null } = {}) {
		this.cancel?.throwIfCancelled();
		let Git = ZoteroGitSync.Git;
		let fullArgs = [
			// Our repository runs no hooks: a global core.hooksPath meant for the
			// user's own working copies has no business here
			...(this.gitDir ? [`--git-dir=${this.gitDir}`, '-c', `core.hooksPath=${PathUtils.join(this.gitDir, 'no-hooks')}`] : []),
			...args,
		];
		let label = args.filter(a => !a.startsWith('--git-dir')).slice(0, 3).join(' ');
		ZoteroGitSync.log(`git ${label}`);

		let proc;
		try {
			proc = await Git.Subprocess.call({
				command: this.gitPath,
				arguments: fullArgs,
				environment: { ...this._environment(), ...(env || {}) },
				environmentAppend: true,
				stderr: 'pipe',
				workdir: this.gitDir && await IOUtils.exists(this.gitDir) ? this.gitDir : Zotero.getTempDirectory().path,
			});
		}
		catch (e) {
			throw new ZoteroGitSync.GitError(`Could not run git (${this.gitPath}): ${e.message || e}`, { args });
		}

		let killedFor = null;
		let kill = (reason) => {
			if (!killedFor) {
				killedFor = reason;
				try {
					proc.kill(1000);
				}
				catch (e) {}
			}
		};
		let removeCancel = this.cancel?.onCancel(() => kill('cancelled')) || (() => {});
		let timer = null;
		let arm = () => {
			clearTimeout(timer);
			timer = setTimeout(() => kill('timeout'), network ? Repository.NETWORK_IDLE_MS : timeout);
		};
		arm();
		let activity = network ? arm : null;

		let stderr = '';
		let stderrReader = (async () => {
			let reader = new ZoteroGitSync.PipeReader(proc.stderr, activity);
			let chunk;
			while ((chunk = await reader.chunk())) {
				let text = ZoteroGitSync.Utils.textDecoder.decode(chunk, { stream: true });
				stderr = (stderr + text).slice(-65536);
				onStderr?.(text);
			}
		})();

		let stdoutReader = new ZoteroGitSync.PipeReader(proc.stdout, activity);
		let stdoutPromise = consume ? consume(stdoutReader) : stdoutReader.rest();

		let inputError = null;
		let inputPromise = (async () => {
			try {
				if (typeof input === 'function') {
					// Subprocess takes ownership of the buffers it is given, so the
					// streaming writer always passes a copy
					await input(data => proc.stdin.write(typeof data === 'string' ? data : data.slice()));
				}
				else if (input !== null) {
					await proc.stdin.write(typeof input === 'string' ? input : input.slice());
				}
			}
			catch (e) {
				// The process exited before reading everything; its exit code and
				// stderr say why
				inputError = e;
			}
			finally {
				try {
					await proc.stdin.close();
				}
				catch (e) {}
			}
		})();

		let result;
		let consumeError = null;
		try {
			result = await stdoutPromise;
		}
		catch (e) {
			consumeError = e;
			kill('consumer');
		}
		await stderrReader.catch(() => {});
		let { exitCode } = await proc.wait();
		if (!killedFor) {
			await inputPromise;
		}
		clearTimeout(timer);
		removeCancel();

		if (killedFor === 'cancelled') {
			throw new ZoteroGitSync.CancelledError();
		}
		if (killedFor === 'timeout') {
			throw new ZoteroGitSync.GitError(
				network
					? `git ${args[0]} stopped responding. If the server asks for a password or a key passphrase, `
						+ 'set up an SSH agent or a credential helper -- the plugin cannot answer prompts.'
					: `git ${args[0]} took too long and was stopped.`,
				{ args, exitCode, stderr }
			);
		}
		if (consumeError) {
			throw consumeError;
		}
		if (!okExitCodes.includes(exitCode)) {
			ZoteroGitSync.log(`git ${label} exited with ${exitCode}: ${ZoteroGitSync.Utils.redactURLs(stderr).slice(-2000)}`);
			throw new ZoteroGitSync.GitError(this._explain(stderr, args), { args, exitCode, stderr });
		}
		if (inputError) {
			throw new ZoteroGitSync.GitError(`git ${args[0]} stopped reading its input: ${inputError.message || inputError}`, { args, exitCode, stderr });
		}
		let stdoutBytes = consume ? null : result;
		return {
			stdout: stdoutBytes ? ZoteroGitSync.Utils.textDecoder.decode(stdoutBytes) : '',
			stdoutBytes,
			stderr,
			exitCode,
			result: consume ? result : undefined,
		};
	}


	// -- Setup -------------------------------------------------------------

	/**
	 * Create the bare repository if needed and point `origin` at the configured
	 * remote. A changed remote URL is simply updated: objects already fetched
	 * are content-addressed and stay valid.
	 */
	async init() {
		if (!await IOUtils.exists(PathUtils.join(this.gitDir, 'HEAD'))) {
			await IOUtils.makeDirectory(this.gitDir, { ignoreExisting: true, createAncestors: true });
			await this.run(['init', '--bare', '--quiet']);
			ZoteroGitSync.log(`Created local repository ${this.gitDir}`);
		}
		let current = await this.run(['config', '--get', 'remote.origin.url'], { okExitCodes: [0, 1] });
		if (current.exitCode === 1) {
			await this.run(['remote', 'add', 'origin', this.remoteURL]);
		}
		else if (current.stdout.trim() !== this.remoteURL) {
			await this.run(['remote', 'set-url', 'origin', this.remoteURL]);
		}
		// Tidy on our schedule, not in the middle of building a commit
		await this.run(['config', 'gc.auto', '0']);
	}


	/**
	 * @return {Promise<String|null>} Who commits will be attributed to, or null
	 * 		when git has no identity configured and none was set in the plugin
	 */
	async identity() {
		if (this.author?.name && this.author?.email) {
			return `${this.author.name} <${this.author.email}>`;
		}
		let result = await this.run(['var', 'GIT_COMMITTER_IDENT'], { okExitCodes: [0, 128] });
		return result.exitCode === 0 ? result.stdout.replace(/>.*$/s, '>').trim() : null;
	}


	// -- Reading the remote ------------------------------------------------

	/**
	 * Fetch the branch.
	 *
	 * @return {Promise<String|null>} The branch's head commit, or null when the
	 * 		remote has no such branch (an empty repository, say)
	 */
	async fetch({ onProgress = null } = {}) {
		let result = await this.run(
			['fetch', '--progress', '--no-tags', 'origin', `+refs/heads/${this.branch}:${this.trackingRef}`],
			{ network: true, okExitCodes: [0, 128], onStderr: onProgress ? text => this._progressLine(text, onProgress) : null }
		);
		if (result.exitCode !== 0) {
			if (/couldn't find remote ref/i.test(result.stderr)) {
				await this.run(['update-ref', '-d', this.trackingRef], { okExitCodes: [0, 1] });
				return null;
			}
			throw new ZoteroGitSync.GitError(this._explain(result.stderr, ['fetch']), {
				args: ['fetch'], exitCode: result.exitCode, stderr: result.stderr,
			});
		}
		return this.resolve(this.trackingRef);
	}


	/**
	 * @return {Promise<String|null>} Commit SHA, or null if the ref doesn't exist
	 */
	async resolve(ref) {
		let result = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { okExitCodes: [0, 1] });
		return result.exitCode === 0 ? result.stdout.trim() : null;
	}


	/**
	 * @param {String} [url] - Defaults to the configured remote
	 * @return {Promise<Map<String, String>>} Branch name -> commit SHA
	 */
	async listRemoteBranches(url = this.remoteURL) {
		let { stdout } = await this.run(['ls-remote', '--heads', url], { network: true });
		let branches = new Map();
		for (let line of stdout.split('\n')) {
			let match = line.match(/^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/);
			if (match) {
				branches.set(match[2], match[1]);
			}
		}
		return branches;
	}


	/**
	 * Every blob in a commit, as a Map of path -> { sha, mode, size }.
	 *
	 * @param {String} commit
	 * @return {Promise<Map<String, Object>>}
	 */
	async listTree(commit) {
		let { stdoutBytes } = await this.run(['ls-tree', '-r', '-z', '--long', '--full-tree', commit]);
		let files = new Map();
		let decoder = ZoteroGitSync.Utils.textDecoder;
		let start = 0;
		for (let i = 0; i < stdoutBytes.length; i++) {
			if (stdoutBytes[i] !== 0) {
				continue;
			}
			let record = decoder.decode(stdoutBytes.subarray(start, i));
			start = i + 1;
			let match = record.match(/^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t(.*)$/s);
			if (match && match[2] === 'blob') {
				files.set(match[5], { sha: match[3], mode: match[1], size: Number(match[4]) });
			}
		}
		return files;
	}


	/**
	 * Read many blobs with one process.
	 *
	 * @param {String[]} shas
	 * @return {Promise<Map<String, Uint8Array>>} Missing objects are left out
	 */
	async readBlobs(shas) {
		let unique = [...new Set(shas)];
		let out = new Map();
		if (!unique.length) {
			return out;
		}
		await this.run(['cat-file', '--batch'], {
			input: unique.map(sha => `${sha}\n`).join(''),
			consume: async (reader) => {
				for (let i = 0; i < unique.length; i++) {
					let header = await reader.line();
					if (header === null) {
						break;
					}
					let match = header.match(/^([0-9a-f]+) (\w+) (\d+)$/);
					if (!match) {
						// "<sha> missing"
						continue;
					}
					let bytes = await reader.take(Number(match[3]));
					await reader.take(1);
					if (match[2] === 'blob') {
						out.set(match[1], bytes);
					}
				}
				await reader.rest();
			},
		});
		return out;
	}


	async getBlobBytes(sha) {
		let blob = (await this.readBlobs([sha])).get(sha);
		if (!blob) {
			throw new ZoteroGitSync.GitError(`Object ${sha} is not in the local repository`);
		}
		return blob;
	}


	async getBlobText(sha) {
		return ZoteroGitSync.Utils.textDecoder.decode(await this.getBlobBytes(sha));
	}


	/**
	 * Stream a blob to disk, through a temporary file so a failure never leaves
	 * a truncated attachment behind.
	 *
	 * @return {Promise<Number>} Bytes written
	 */
	async downloadBlob(sha, path) {
		return this._streamToFile(path, ['cat-file', 'blob', sha]);
	}


	async _streamToFile(path, args, options = {}) {
		await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true, createAncestors: true });
		let tmpPath = `${path}.zgit-download`;
		await IOUtils.write(tmpPath, new Uint8Array(0));
		let written = 0;
		try {
			await this.run(args, {
				...options,
				consume: async (reader) => {
					let pending = [];
					let pendingBytes = 0;
					let flush = async () => {
						if (!pendingBytes) {
							return;
						}
						let buffer = new Uint8Array(pendingBytes);
						let offset = 0;
						for (let part of pending) {
							buffer.set(part, offset);
							offset += part.length;
						}
						await IOUtils.write(tmpPath, buffer, { mode: 'append' });
						written += pendingBytes;
						pending = [];
						pendingBytes = 0;
					};
					let chunk;
					while ((chunk = await reader.chunk())) {
						pending.push(chunk);
						pendingBytes += chunk.length;
						if (pendingBytes >= ZoteroGitSync.Files.READ_CHUNK_BYTES) {
							await flush();
						}
					}
					await flush();
				},
			});
			await IOUtils.move(tmpPath, path);
		}
		catch (e) {
			await IOUtils.remove(tmpPath, { ignoreAbsent: true });
			throw e;
		}
		return written;
	}


	// -- Writing objects ---------------------------------------------------

	/**
	 * Store small files held in memory, all through one `git fast-import`.
	 * Objects the repository already has are skipped by git.
	 *
	 * @param {Object[]} blobs - { sha, bytes }
	 */
	async writeTextBlobs(blobs) {
		if (!blobs.length) {
			return;
		}
		let encode = s => ZoteroGitSync.Utils.encode(s);
		await this.run(['fast-import', '--quiet', '--done'], {
			input: async (write) => {
				const FLUSH = 4 * 1024 * 1024;
				let parts = [];
				let size = 0;
				let flush = async () => {
					if (!size) {
						return;
					}
					let buffer = new Uint8Array(size);
					let offset = 0;
					for (let part of parts) {
						buffer.set(part, offset);
						offset += part.length;
					}
					parts = [];
					size = 0;
					await write(buffer);
				};
				for (let blob of blobs) {
					for (let part of [encode(`blob\ndata ${blob.bytes.length}\n`), blob.bytes, encode('\n')]) {
						parts.push(part);
						size += part.length;
					}
					if (size >= FLUSH) {
						await flush();
					}
				}
				parts.push(encode('done\n'));
				size += 5;
				await flush();
			},
		});
		// fast-import has no way to report the IDs of mark-less blobs, so check
		// that what we expect to reference now exists
		let missing = await this.missingObjects(blobs.map(b => b.sha));
		if (missing.length) {
			throw new ZoteroGitSync.GitError(`git fast-import did not store ${missing.length} object(s), e.g. ${missing[0]}`);
		}
	}


	/**
	 * Store attachment files: git reads each one from disk itself.
	 *
	 * @param {Object[]} files - { path, sha } where sha is what we expect
	 */
	async writeFileBlobs(files) {
		if (!files.length) {
			return;
		}
		let { stdout } = await this.run(['hash-object', '-w', '--no-filters', '--stdin-paths'], {
			input: files.map(f => `${f.path}\n`).join(''),
			timeout: 60 * 60 * 1000,
		});
		let shas = stdout.trim().split('\n');
		files.forEach((file, i) => {
			if (shas[i] !== file.sha) {
				// The hash cache or the file is out of date; committing the wrong
				// content under the expected name would be worse than stopping
				throw new ZoteroGitSync.GitError(
					`${file.path} changed during sync (expected ${file.sha}, git read ${shas[i] || 'nothing'}); sync again`
				);
			}
		});
	}


	/**
	 * @param {String[]} shas
	 * @return {Promise<String[]>} The ones the repository doesn't have
	 */
	async missingObjects(shas) {
		let unique = [...new Set(shas)];
		if (!unique.length) {
			return [];
		}
		let { stdout } = await this.run(['cat-file', '--batch-check'], { input: unique.map(sha => `${sha}\n`).join('') });
		return stdout.split('\n').filter(line => / missing$/.test(line)).map(line => line.split(' ')[0]);
	}


	/**
	 * Apply changes to a commit's tree, on a private index file.
	 *
	 * @param {String|null} baseCommit
	 * @param {Object[]} entries - { path, sha } to add or replace, { path, sha: null } to delete
	 * @return {Promise<String>} The new tree's SHA
	 */
	async buildTree(baseCommit, entries) {
		let indexPath = PathUtils.join(this.gitDir, 'zgit-index');
		let run = (args, options = {}) => this.run(args, { ...options, env: { GIT_INDEX_FILE: indexPath } });
		await IOUtils.remove(indexPath, { ignoreAbsent: true });
		try {
			await run(baseCommit ? ['read-tree', baseCommit] : ['read-tree', '--empty']);
			if (entries.length) {
				let records = [];
				for (let entry of entries) {
					records.push(entry.sha
						? `100644 ${entry.sha}\t${entry.path}\0`
						: `0 ${Repository.EMPTY_SHA}\t${entry.path}\0`);
				}
				await run(['update-index', '-z', '--index-info'], { input: records.join('') });
			}
			let { stdout } = await run(['write-tree']);
			return stdout.trim();
		}
		finally {
			await IOUtils.remove(indexPath, { ignoreAbsent: true });
		}
	}


	/**
	 * @return {Promise<String>} The new commit's SHA
	 */
	async commitTree({ tree, parents = [], message }) {
		let args = ['commit-tree', tree];
		for (let parent of parents) {
			args.push('-p', parent);
		}
		let fallback = null;
		if (!await this.identity()) {
			// git refuses to commit without an identity; don't make that the
			// user's problem when the plugin settings can say who it is later
			fallback = {
				GIT_AUTHOR_NAME: 'Zotero Git Sync', GIT_AUTHOR_EMAIL: 'zotero-git-sync@localhost',
				GIT_COMMITTER_NAME: 'Zotero Git Sync', GIT_COMMITTER_EMAIL: 'zotero-git-sync@localhost',
			};
		}
		let { stdout } = await this.run([...args, '-F', '-'], { input: message, env: fallback });
		return stdout.trim();
	}


	/**
	 * Publish a commit as the branch. The server refuses it if the branch no
	 * longer points at the commit's parent -- another computer synced in the
	 * meantime -- and the error carries `branchMoved`.
	 */
	async push(commit, { onProgress = null } = {}) {
		let result = await this.run(
			['push', '--porcelain', '--progress', '--no-verify', 'origin', `${commit}:refs/heads/${this.branch}`],
			{ network: true, okExitCodes: [0, 1, 128], onStderr: onProgress ? text => this._progressLine(text, onProgress) : null }
		);
		let rejected = result.stdout.split('\n').find(line => line.startsWith('!'));
		if (result.exitCode === 0 && !rejected) {
			await this.run(['update-ref', this.trackingRef, commit]);
			return;
		}
		if (rejected && /non-fast-forward|fetch first|stale info/.test(rejected)) {
			throw new ZoteroGitSync.GitError('The branch moved on the server during the sync', {
				args: ['push'], exitCode: result.exitCode, stderr: result.stderr, branchMoved: true,
			});
		}
		let detail = [result.stderr, rejected || ''].join('\n');
		throw new ZoteroGitSync.GitError(this._explain(detail, ['push']), {
			args: ['push'], exitCode: result.exitCode, stderr: detail,
		});
	}


	/**
	 * Pack loose objects now and then, so a year of syncs doesn't leave tens of
	 * thousands of files in the object directory.
	 */
	async maintain() {
		try {
			await this.run(['-c', 'gc.auto=6700', 'gc', '--auto', '--quiet'], { timeout: 30 * 60 * 1000 });
		}
		catch (e) {
			ZoteroGitSync.logError(e);
		}
	}


	/**
	 * git prints progress with carriage returns; pass on the last complete
	 * "Label: NN% (a/b)" line.
	 */
	_progressLine(text, onProgress) {
		let lines = text.split(/[\r\n]+/).filter(Boolean);
		for (let i = lines.length - 1; i >= 0; i--) {
			let match = lines[i].match(/^(?:remote: )?([A-Za-z ]+):\s+(\d+)% \((\d+)\/(\d+)\)/);
			if (match) {
				onProgress({ label: match[1].trim(), percent: Number(match[2]), done: Number(match[3]), total: Number(match[4]) });
				return;
			}
		}
	}


	// -- Git LFS -----------------------------------------------------------

	async lfsAvailable() {
		try {
			await this.run(['lfs', 'version'], { timeout: 30000 });
			return true;
		}
		catch (e) {
			if (e instanceof ZoteroGitSync.CancelledError) {
				throw e;
			}
			return false;
		}
	}


	async lfsMediaDir() {
		if (!this._lfsMediaDir) {
			let { stdout } = await this.run(['lfs', 'env'], { timeout: 60000 });
			let match = stdout.match(/^LocalMediaDir=(.+)$/m);
			this._lfsMediaDir = match ? match[1].trim() : PathUtils.join(this.gitDir, 'lfs', 'objects');
		}
		return this._lfsMediaDir;
	}


	async _lfsObjectPath(oid) {
		return PathUtils.join(await this.lfsMediaDir(), oid.slice(0, 2), oid.slice(2, 4), oid);
	}


	/**
	 * Upload files to the remote's Git LFS storage. git-lfs uploads from its own
	 * object directory, so each file is copied there first and removed again
	 * once the server has it -- Zotero's storage keeps the original.
	 *
	 * @param {Object[]} objects - { oid, size, path }
	 * @param {Object} [options]
	 * @param {Function} [options.onProgress] - (done, total)
	 */
	async lfsUpload(objects, { onProgress = () => {} } = {}) {
		let unique = [...new Map(objects.map(o => [o.oid, o])).values()];
		let done = 0;
		for (let i = 0; i < unique.length; i += Repository.LFS_BATCH) {
			let batch = unique.slice(i, i + Repository.LFS_BATCH);
			let staged = [];
			try {
				for (let object of batch) {
					this.cancel?.throwIfCancelled();
					let target = await this._lfsObjectPath(object.oid);
					let stat = await ZoteroGitSync.Files.statFile(target);
					if (!stat || stat.size !== object.size) {
						await IOUtils.makeDirectory(PathUtils.parent(target), { ignoreExisting: true, createAncestors: true });
						await IOUtils.copy(object.path, `${target}.zgit-tmp`);
						let copied = await ZoteroGitSync.Files.statFile(`${target}.zgit-tmp`);
						if (copied?.size !== object.size) {
							await IOUtils.remove(`${target}.zgit-tmp`, { ignoreAbsent: true });
							throw new ZoteroGitSync.GitError(`${object.path} changed during sync; sync again`);
						}
						await IOUtils.move(`${target}.zgit-tmp`, target);
					}
					staged.push(target);
				}
				await this.run(['lfs', 'push', '--object-id', 'origin', ...batch.map(o => o.oid)], {
					network: true,
					onStderr: (text) => {
						let match = text.match(/Uploading LFS objects:\s+\d+% \((\d+)\/(\d+)\)[^\r\n]*$/);
						if (match) {
							onProgress(done + Number(match[1]), unique.length);
						}
					},
				});
				done += batch.length;
				onProgress(done, unique.length);
			}
			finally {
				for (let path of staged) {
					await IOUtils.remove(path, { ignoreAbsent: true });
				}
			}
		}
	}


	/**
	 * Download a Git LFS object to a file, given its pointer.
	 *
	 * @param {String} pointerText
	 * @param {String} path - Destination
	 * @param {String} repoPath - The pointer's path in the repository, for git-lfs's messages
	 * @return {Promise<Number>} Bytes written
	 */
	async lfsDownload(pointerText, path, repoPath) {
		let pointer = ZoteroGitSync.Utils.parseLFSPointer(pointerText);
		try {
			let written = await this._streamToFile(path, ['lfs', 'smudge', repoPath], {
				input: pointerText,
				network: true,
			});
			if (pointer && written !== pointer.size) {
				await IOUtils.remove(path, { ignoreAbsent: true });
				throw new ZoteroGitSync.GitError(`Git LFS returned ${written} bytes for ${repoPath}, expected ${pointer.size}`);
			}
			return written;
		}
		finally {
			// git-lfs keeps a copy of what it downloaded; the attachment is the copy we need
			if (pointer) {
				await IOUtils.remove(await this._lfsObjectPath(pointer.oid), { ignoreAbsent: true });
			}
		}
	}
};
