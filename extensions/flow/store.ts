import { randomUUID } from 'node:crypto';
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Action } from './contract.ts';

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
function area(root: string, kind: Kind, create: boolean) {
	if (kind !== 'action' && kind !== 'flow') throw new Error('Invalid definition namespace');
	const parent = join(root, 'ldk-flow'),
		dir = join(parent, kind === 'action' ? 'actions' : 'flows');
	for (const path of [root, parent, dir]) {
		if (directory(path)) continue;
		if (!create) return undefined;
		try {
			mkdirSync(path, { recursive: path === root, mode: 0o700 });
		} catch (e) {
			if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
		}
		if (!directory(path)) throw new Error(`Missing storage directory: ${path}`);
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
export function readDef(root: string, kind: Kind, name: string): unknown {
	const file = filename(name),
		dir = area(root, kind, false),
		path = dir && join(dir, file);
	if (!path) throw new Error(`Unknown ${kind}: ${name}`);
	if (!lstatSync(path).isFile()) throw new Error(`Not a regular definition: ${path}`);
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > limit) throw new Error(`Invalid or oversized definition: ${path}`);
		return JSON.parse(readFileSync(fd, 'utf8'));
	} finally {
		closeSync(fd);
	}
}
export function saveDef(root: string, kind: Kind, name: string, value: unknown): void {
	const file = filename(name),
		json = JSON.stringify(value, null, 2);
	if (json === undefined || Buffer.byteLength(json) + 1 > limit)
		throw new Error('Invalid definition or definition exceeds 4 MiB');
	const dir = area(root, kind, true)!,
		path = join(dir, file),
		tmp = join(dir, `.new-${randomUUID()}`);
	const dest = lstatSync(path, { throwIfNoEntry: false });
	if (dest && !dest.isFile()) throw new Error(`Not a regular definition: ${path}`);
	const fd = openSync(tmp, 'wx', 0o600);
	try {
		try {
			writeFileSync(fd, json + '\n');
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, path);
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
