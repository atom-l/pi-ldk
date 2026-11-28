import { createHash, randomUUID } from 'node:crypto';
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Action, Flow } from './contract.ts';

type Kind = 'flow' | 'action';
const limit = 4 * 1024 * 1024;
const absent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
function directory(path: string): boolean {
	try {
		if (lstatSync(path).isDirectory()) return true;
	} catch (err) {
		if (absent(err)) return false;
		throw err;
	}
	throw new Error(`Not a directory (symlinks are not followed): ${path}`);
}
/** Pi resolves project settings from the host cwd, not /wd, shell cwd, or the path of a resumed transcript. */
export function rootFor(ctx: ExtensionContext): string {
	const project = resolve(ctx.cwd, '.pi');
	return directory(project) ? project : resolve(getAgentDir());
}
function filename(name: string) {
	// Hex is reversible and case-sensitive even on a case-insensitive filesystem.
	if (
		typeof name !== 'string' ||
		!name.trim() ||
		name !== name.trim() ||
		/[:/\\\x00-\x1f\x7f]/u.test(name) ||
		name === '.' ||
		name === '..' ||
		Buffer.from(name).toString('utf8') !== name ||
		Buffer.byteLength(name) > 120
	) {
		throw new Error(
			'Invalid definition name: use 1–120 UTF-8 bytes, without outer whitespace, control characters, slash, backslash or colon.',
		);
	}
	return Buffer.from(name).toString('hex') + '.json';
}
function ensureDirectory(path: string, recursive = false) {
	if (directory(path)) return;
	try {
		mkdirSync(path, { recursive, mode: 0o700 });
	} catch (e) {
		if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
	}
	if (!directory(path)) throw new Error(`Missing storage directory: ${path}`);
}
function area(root: string, kind: Kind, create: boolean) {
	if (kind !== 'action' && kind !== 'flow') throw new Error('Invalid definition namespace');
	const parent = join(root, 'ldk-flow'),
		dir = join(parent, kind === 'action' ? 'actions' : 'flows');
	for (const path of [root, parent, dir]) {
		if (create) ensureDirectory(path, path === root);
		else if (!directory(path)) return undefined;
	}
	return dir;
}
export function listDefs(root: string, kind: Kind): string[] {
	const dir = area(root, kind, false);
	if (!dir) return [];
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) => {
			if (!/^(?:[a-f0-9]{2}){1,120}\.json$/.test(entry.name)) return [];
			if (!entry.isFile()) throw new Error(`Not a regular definition file: ${join(dir, entry.name)}`);
			const name = Buffer.from(entry.name.slice(0, -5), 'hex').toString('utf8');
			if (filename(name) !== entry.name) throw new Error(`Invalid encoded definition name: ${entry.name}`);
			return [name];
		})
		.sort();
}
function existingPath(root: string, kind: Kind, name: string) {
	const file = filename(name),
		dir = area(root, kind, false),
		path = dir && join(dir, file);
	if (!path) throw new Error(`Unknown ${kind}: ${name}`);
	return path;
}
function readBytes(path: string) {
	if (!lstatSync(path).isFile()) throw new Error(`Not a regular definition: ${path}`);
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fstatSync(fd, { bigint: true });
		if (!stat.isFile() || stat.size > limit) throw new Error(`Invalid or oversized definition: ${path}`);
		return { stat, bytes: readFileSync(fd) };
	} finally {
		closeSync(fd);
	}
}
export function readDef(root: string, kind: Kind, name: string): unknown {
	return JSON.parse(readBytes(existingPath(root, kind, name)).bytes.toString('utf8'));
}
function revision(path: string, { stat, bytes } = readBytes(path)): string {
	// Include identity: an atomic save of identical JSON is still a different definition.
	return createHash('sha256')
		.update(`${resolve(path)}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}\0`)
		.update(bytes)
		.digest('hex');
}
export function readFlowSnapshot(root: string, name: string): { definition: Flow; revision: string } {
	const path = existingPath(root, 'flow', name),
		file = readBytes(path);
	return { definition: JSON.parse(file.bytes.toString('utf8')), revision: revision(path, file) };
}
export function flowRevision(root: string, name: string): string {
	return revision(existingPath(root, 'flow', name));
}
// Atomic mkdir serializes cooperating processes without waiting on another Pi's event loop.
// Never steal a lock; a crashed writer may require manual cleanup of an empty lock directory.
function withFlowLock<T>(path: string, perform: () => T): T {
	const lock = join(dirname(path), `.lock-${basename(path)}`);
	try {
		mkdirSync(lock, { mode: 0o700 });
	} catch (e) {
		if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') throw new Error(`Flow is busy (lock: ${lock}); retry.`);
		throw e;
	}
	try {
		return perform();
	} finally {
		rmdirSync(lock);
	}
}
export function archiveFlow(root: string, name: string, expectedRevision: string): string {
	const path = existingPath(root, 'flow', name);
	return withFlowLock(path, () => {
		if (revision(path) !== expectedRevision) throw new Error(`Flow changed; confirm the current definition: ${name}`);
		const trash = join(root, 'ldk-flow', 'trash'),
			flows = join(trash, 'flows');
		ensureDirectory(trash);
		ensureDirectory(flows);
		// A fresh private directory guarantees rename never replaces an earlier archive.
		const slot = mkdtempSync(join(flows, 'archive-')),
			archived = join(slot, basename(path));
		try {
			renameSync(path, archived);
		} catch (e) {
			rmdirSync(slot);
			throw e;
		}
		return archived;
	});
}
/** Flow only: undefined replaces unconditionally, null creates only, a token edits only that revision. */
export function saveDef(root: string, kind: Kind, name: string, value: unknown, expectedFlowRevision?: string | null): void {
	const file = filename(name),
		json = JSON.stringify(value, null, 2);
	if (json === undefined || Buffer.byteLength(json) + 1 > limit)
		throw new Error('Invalid definition or definition exceeds 4 MiB');
	const dir = area(root, kind, kind !== 'flow' || expectedFlowRevision == null);
	const conflict = () => new Error(`Flow changed; reopen before saving: ${name}`);
	if (!dir) throw conflict();
	const path = join(dir, file),
		tmp = join(dir, `.new-${randomUUID()}`);
	const replace = () => {
		const dest = lstatSync(path, { throwIfNoEntry: false });
		if (dest && !dest.isFile()) throw new Error(`Not a regular definition: ${path}`);
		if (kind === 'flow' && expectedFlowRevision !== undefined) {
			const matches = expectedFlowRevision === null ? !dest : dest && revision(path) === expectedFlowRevision;
			if (!matches) throw conflict();
		}
		renameSync(tmp, path);
	};
	const fd = openSync(tmp, 'wx', 0o600);
	try {
		try {
			writeFileSync(fd, json + '\n');
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (kind === 'flow') withFlowLock(path, replace);
		else replace();
	} finally {
		try {
			unlinkSync(tmp);
		} catch (e) {
			if (!absent(e)) throw e;
		}
	}
}
export function globalsFor(root: string): Record<string, Action> {
	return Object.fromEntries(listDefs(root, 'action').map((name) => [name, readDef(root, 'action', name) as Action]));
}
