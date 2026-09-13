// Just enough of Firefox's Subprocess, IOUtils and PathUtils to run src/git.js
// under Node against the real git. Behaviour that matters is copied from the
// Firefox modules: read() without a length returns the next chunk and an empty
// buffer at the end, write() takes ownership of what it is given.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

class InputPipe {
	constructor(stream) {
		this.chunks = [];
		this.waiters = [];
		this.ended = false;
		stream.on('data', (data) => {
			this.chunks.push(data);
			this._wake();
		});
		stream.on('end', () => {
			this.ended = true;
			this._wake();
		});
	}

	_wake() {
		for (let waiter of this.waiters.splice(0)) {
			waiter();
		}
	}

	async read() {
		while (!this.chunks.length && !this.ended) {
			await new Promise(resolve => this.waiters.push(resolve));
		}
		if (!this.chunks.length) {
			return new ArrayBuffer(0);
		}
		let chunk = this.chunks.shift();
		return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
	}
}

export const Subprocess = {
	getEnvironment() {
		return { ...process.env };
	},

	async pathSearch(bin, environment) {
		for (let dir of String(environment.PATH || '').split(':')) {
			let candidate = path.join(dir, bin);
			try {
				accessSync(candidate, constants.X_OK);
				if (statSync(candidate).isFile()) {
					return candidate;
				}
			}
			catch (e) {}
		}
		throw new Error(`Executable not found: ${bin}`);
	},

	async call({ command, arguments: args, environment, environmentAppend, workdir, stderr }) {
		let env = environmentAppend ? { ...process.env, ...environment } : environment;
		let child = spawn(command, args, { cwd: workdir || undefined, env, stdio: ['pipe', 'pipe', stderr === 'pipe' ? 'pipe' : 'ignore'] });
		let exit = new Promise(resolve => child.on('close', code => resolve({ exitCode: code ?? -1 })));
		child.stdin.on('error', () => {});
		return {
			stdin: {
				write(data) {
					let buffer = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
					return new Promise((resolve, reject) => {
						if (child.stdin.destroyed) {
							reject(new Error('pipe closed'));
							return;
						}
						child.stdin.write(buffer, e => (e ? reject(e) : resolve({ bytesWritten: buffer.length })));
					});
				},
				close() {
					return new Promise(resolve => child.stdin.end(resolve));
				},
			},
			stdout: new InputPipe(child.stdout),
			stderr: stderr === 'pipe' ? new InputPipe(child.stderr) : { read: async () => new ArrayBuffer(0) },
			wait: () => exit,
			kill() {
				child.kill('SIGTERM');
				return exit;
			},
		};
	},
};

export const PathUtils = {
	join: (...parts) => path.join(...parts),
	parent: p => path.dirname(p),
	filename: p => path.basename(p),
	isAbsolute: p => path.isAbsolute(p),
};

export const IOUtils = {
	exists: async p => existsSync(p),
	async makeDirectory(p) {
		await fs.mkdir(p, { recursive: true });
	},
	async remove(p, { recursive = false } = {}) {
		await fs.rm(p, { force: true, recursive });
	},
	move: (a, b) => fs.rename(a, b),
	copy: (a, b) => fs.copyFile(a, b),
	async read(p) {
		return new Uint8Array(await fs.readFile(p));
	},
	async write(p, data, { mode } = {}) {
		if (mode === 'append') {
			await fs.appendFile(p, data);
		}
		else {
			await fs.writeFile(p, data);
		}
	},
	readUTF8: p => fs.readFile(p, 'utf8'),
	writeUTF8: (p, s) => fs.writeFile(p, s),
	async stat(p) {
		let info = await fs.stat(p);
		return { size: info.size, lastModified: info.mtimeMs, type: info.isDirectory() ? 'directory' : info.isFile() ? 'regular' : 'other' };
	},
};

export function install(extra = {}) {
	Object.assign(globalThis, {
		PathUtils,
		IOUtils,
		ChromeUtils: { importESModule: () => ({ Subprocess }) },
		Zotero: { isWin: false, getTempDirectory: () => ({ path: os.tmpdir() }), ...extra.Zotero },
	});
}
