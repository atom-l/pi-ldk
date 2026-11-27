import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { validateAction, type Action, type Join, type Port, type PortType } from './contract.ts';
import { clean } from './graph-lines.ts';

type Ctx = ExtensionCommandContext;
type Ports = Record<string, Port>;
type TextField = 'template' | 'question' | 'test';
type Field = keyof Action;
type Row<T> = readonly [T, string];
const builtins = ['action', 'task', 'start', 'end', 'decision', 'fork', 'join', 'gate'].map((k) => `builtin:${k}`);
const portTypes: PortType[] = ['any', 'text', 'boolean', 'object', 'file', 'null'];
const inherit = '继承父级';
const labels: Record<Field, string> = {
	extends: '父级 · extends',
	inputs: '输入端口 · inputs',
	outputs: '输出端口 · outputs',
	template: '模型模板 · template',
	tools: '允许的工具 · tools',
	test: '布尔判断路径 · test',
	question: '人工关口问题 · question',
	join: '并行收束策略 · join',
};
const preview = (s: unknown) => truncateToWidth(clean(s), 64, '…');
const policy = (j: Join) => `${j.waitFor} / ${j.countOn} / ${j.remaining}`;
const problem = (ctx: Ctx, message: unknown) => ctx.ui.notify(clean(message), 'error');

/** Select by opaque identity, never by parsing a sanitized/truncated port or reference name. */
async function menu<const T>(ctx: Ctx, title: string, rows: readonly Row<T>[]): Promise<T | undefined> {
	const options = rows.map(([, label], i) => `${i + 1}. ${clean(label)}`);
	const choice = await ctx.ui.select(clean(title), options);
	return choice === undefined ? undefined : rows[options.indexOf(choice)]?.[0];
}
function assign<K extends Exclude<Field, 'extends'>>(draft: Action, key: K, value: Action[K]) {
	if (value === undefined) delete draft[key];
	else draft[key] = value;
}
function fields(action: Action): Field[] {
	const kind = builtins.includes(action.extends) ? action.extends.slice(8) : undefined;
	const model = !kind || ['action', 'task', 'decision', 'join'].includes(kind);
	// Never hide an existing override: after reparenting it may need to be removed to pass validation.
	return (Object.keys(labels) as Field[]).filter((k) => {
		if (Object.hasOwn(action, k)) return true;
		if (k === 'template' || k === 'tools') return model;
		if (k === 'test') return !kind || kind === 'decision';
		if (k === 'question') return !kind || kind === 'gate';
		if (k === 'join') return !kind || kind === 'join';
		return true;
	});
}
function summary(a: Action, k: Field): string {
	if (a[k] === undefined) return inherit;
	switch (k) {
		case 'inputs':
		case 'outputs':
			return `${Object.keys(a[k]!).length} 个（整组覆盖）`;
		case 'tools':
			return a.tools!.length ? `${a.tools!.length} 个 · ${preview(a.tools![0])}` : '无工具（显式空列表）';
		case 'join':
			return policy(a.join!);
		default:
			return preview(a[k]);
	}
}
function safeText(text: string, multiline: boolean) {
	// Only the multiline editor gets literal line breaks. Never feed stored escapes/OSC into a Pi control.
	return (multiline ? text.split('\n') : [text]).every((line) => clean(line) === line);
}
async function editText(ctx: Ctx, draft: Action, key: TextField) {
	const row = await menu(ctx, labels[key], [
		['edit', '填写或修改文本'],
		['inherit', `移除覆盖 · ${inherit}`],
	]);
	if (!row) return;
	if (row === 'inherit') {
		delete draft[key];
		return;
	}
	const old = draft[key] ?? '';
	// Pi's Editor normalizes line endings and expands tabs. Preserve exact original on an unchanged submission.
	const initial = old.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
	const safe = safeText(initial, true);
	if (!safe && !(await ctx.ui.confirm(labels[key], '旧文本含终端控制字符，不会载入编辑器。要用新文本替换吗？'))) return;
	let prefill = safe ? initial : '';
	for (;;) {
		const text = await ctx.ui.editor(labels[key], prefill);
		if (text === undefined || (safe && text === initial && old.trim())) return;
		if (!safeText(text, true)) {
			problem(ctx, '文本不允许终端控制字符。');
			return;
		}
		if (!text.trim()) {
			problem(ctx, `文本不可为空；若要移除，请选择「${inherit}」。`);
			prefill = text;
			continue;
		}
		draft[key] = text;
		return;
	}
}

async function nameInput(ctx: Ctx, title: string, used: string[], port: boolean): Promise<string | undefined> {
	for (;;) {
		const value = await ctx.ui.input(title);
		if (value === undefined) return;
		if (!value.trim() || !safeText(value, false)) problem(ctx, '名称不能为空或含控制字符。');
		else if (port && (value === 'prototype' || Object.hasOwn(Object.prototype, value))) problem(ctx, '这是保留名称。');
		else if (used.includes(value)) problem(ctx, '名称已存在。');
		else return value;
	}
}
async function editTools(ctx: Ctx, original: string[] | undefined): Promise<string[] | undefined> {
	let value = original;
	for (;;) {
		const rows: Row<string | number>[] = [
			['done', '应用工具设置'],
			['add', '添加工具名称'],
			['none', '禁用全部工具（空列表）'],
			['inherit', `移除覆盖 · ${inherit}`],
		];
		value?.forEach((t, i) => rows.push([i, `移除 · ${preview(t)}`]));
		const choice = await menu(
			ctx,
			`允许的工具 · ${value === undefined ? inherit : `${value.length} 个（整组覆盖）`}`,
			rows,
		);
		if (choice === undefined) return original;
		if (choice === 'done') return value;
		if (choice === 'none') value = [];
		else if (choice === 'inherit') value = undefined;
		else if (choice === 'add') {
			const name = await nameInput(ctx, '新增工具 · 精确的 Pi 工具名', value ?? [], false);
			if (name !== undefined) value = [...(value ?? []), name];
		} else value = value?.filter((_, i) => i !== choice);
	}
}
async function portType(ctx: Ctx): Promise<PortType | undefined> {
	return menu(
		ctx,
		'端口类型',
		portTypes.map((t) => [t, t] as const),
	);
}
/** Copy-on-write at each level. Esc rolls back this scope (including completed child edits). */
async function editPorts(ctx: Ctx, original: Ports | undefined, path: string, depth = 0): Promise<Ports | undefined> {
	let value = original;
	const absent = depth ? '不约束对象字段' : inherit;
	for (;;) {
		const entries = Object.entries(value ?? {});
		const rows: Row<string | number>[] = [
			['done', '应用此组'],
			['add', depth ? '添加字段' : '添加端口'],
			['empty', '显式空组 {}'],
			['unset', `移除声明 · ${absent}`],
		];
		entries.forEach(([k, p], i) =>
			rows.push([i, `${preview(k)} : ${p.type}${p.fields ? ` · ${Object.keys(p.fields).length} 个字段` : ''}`]),
		);
		const choice = await menu(
			ctx,
			`${path} · ${value === undefined ? absent : `${entries.length} 项`} · 整组覆盖`,
			rows,
		);
		if (choice === undefined) return original;
		if (choice === 'done') return value;
		if (choice === 'unset') {
			value = undefined;
			continue;
		}
		if (choice === 'empty') {
			value = {};
			continue;
		}
		const names = entries.map(([k]) => k);
		if (choice === 'add') {
			const name = await nameInput(ctx, depth ? '字段名' : '端口名', names, true);
			if (name === undefined) continue;
			const type = await portType(ctx);
			if (type) value = { ...value, [name]: { type } };
			continue;
		}
		if (typeof choice !== 'number') continue;
		const [key, port] = entries[choice];
		const title = `${path} › ${preview(key)}`;
		const actions: Row<string>[] = [
			['type', `类型 · ${port.type}`],
			['rename', '重命名'],
			['delete', '删除此项'],
		];
		if (port.type === 'object') actions.unshift(['fields', '编辑对象字段 · fields']);
		const edit = await menu(ctx, title, actions);
		if (edit === 'delete') value = Object.fromEntries(entries.filter(([k]) => k !== key));
		if (edit === 'rename') {
			const name = await nameInput(
				ctx,
				'新名称',
				names.filter((k) => k !== key),
				true,
			);
			if (name !== undefined) value = Object.fromEntries(entries.map(([k, p]) => [k === key ? name : k, p]));
		}
		if (edit === 'type') {
			const type = await portType(ctx);
			if (!type || type === port.type) continue;
			if (port.fields && !(await ctx.ui.confirm(clean(title), '更改类型将移除此项的字段声明，继续？'))) continue;
			value = { ...value, [key]: { type } };
		}
		if (edit === 'fields') {
			if (depth >= 64) {
				problem(ctx, '字段嵌套已达到契约上限（64）。');
				continue;
			}
			const f = await editPorts(ctx, port.fields, title, depth + 1);
			if (f !== port.fields)
				value = { ...value, [key]: f === undefined ? { type: 'object' } : { type: 'object', fields: f } };
		}
	}
}
const defaultJoin: Join = { waitFor: 'all', countOn: 'succeeded', remaining: 'cancel' };
async function editJoin(ctx: Ctx, original?: Join): Promise<Join | undefined> {
	let value = original;
	for (;;) {
		const choice = await menu(ctx, `并行收束 · ${value ? policy(value) : inherit}`, [
			['done', '应用收束设置'],
			['waitFor', '等待数量 · waitFor'],
			['countOn', '计数条件 · countOn'],
			['remaining', '剩余 worker · remaining'],
			['inherit', `移除覆盖 · ${inherit}`],
		]);
		if (!choice) return original;
		if (choice === 'done') return value;
		if (choice === 'inherit') {
			value = undefined;
			continue;
		}
		// The contract replaces the whole join policy, not individual inherited members.
		const base = value ?? defaultJoin;
		if (choice === 'waitFor') {
			const mode = await menu(ctx, '等待数量', [
				['all', 'all · 全部'],
				['number', '指定正整数阈值'],
			]);
			if (mode === 'all') value = { ...base, waitFor: 'all' };
			if (mode === 'number') {
				for (;;) {
					const n = await ctx.ui.input('等待多少个 worker？');
					if (n === undefined) break;
					if (/^[1-9]\d*$/u.test(n) && Number.isSafeInteger(Number(n))) {
						value = { ...base, waitFor: Number(n) };
						break;
					}
					problem(ctx, 'waitFor 必须是可安全表示的正整数。');
				}
			}
		} else if (choice === 'countOn') {
			const v = await menu(ctx, '计数条件', [
				['succeeded', 'succeeded · 成功交付'],
				['settled', 'settled · 任意终态'],
			]);
			if (v) value = { ...base, countOn: v };
		} else {
			const v = await menu(ctx, '未完成 worker', [
				['cancel', 'cancel · 请求取消'],
				['finish', 'finish · 允许收尾'],
			]);
			if (v) value = { ...base, remaining: v };
		}
	}
}

/** A detached Action draft, not a resolved Action. File writes and scope-aware validation belong to the caller. */
export async function editAction(ctx: Ctx, action: Action, refs: string[], location = ''): Promise<Action | undefined> {
	const draft = structuredClone(action);
	const parents = [...new Set([...builtins, ...refs])];
	for (;;) {
		const rows: Row<Field | 'done'>[] = [
			['done', '完成 · 应用属性'],
			...fields(draft).map((k) => [k, `${labels[k]}：${summary(draft, k)}`] as const),
		];
		const field = await menu(ctx, ['Action 属性', location, 'Esc 取消'].filter(Boolean).join(' · '), rows);
		if (!field) return;
		if (field === 'done') {
			try {
				if (!parents.includes(draft.extends)) throw new Error(`未找到父级引用：${draft.extends}`);
				if (draft.extends.startsWith('builtin:')) validateAction('draft', draft, {});
				return draft;
			} catch (e) {
				problem(ctx, e instanceof Error ? e.message : e);
				continue;
			}
		}
		switch (field) {
			case 'extends': {
				const parent = await menu(
					ctx,
					'选择父级 · 保留现有覆盖',
					parents.map((ref) => [ref, preview(ref)] as const),
				);
				if (parent !== undefined) draft.extends = parent;
				break;
			}
			case 'template':
			case 'question':
			case 'test':
				await editText(ctx, draft, field);
				break;
			case 'inputs':
			case 'outputs':
				assign(draft, field, await editPorts(ctx, draft[field], labels[field]));
				break;
			case 'tools':
				assign(draft, field, await editTools(ctx, draft.tools));
				break;
			case 'join':
				assign(draft, field, await editJoin(ctx, draft.join));
				break;
		}
	}
}

/** Read-only field sheet; does not open an editor (even for long templates). */
export async function viewAction(ctx: Ctx, action: Action, title = 'Action 属性'): Promise<void> {
	const lines: string[] = [];
	function portLines(ports: Ports, indent: string) {
		for (const [k, p] of Object.entries(ports)) {
			lines.push(`${indent}${clean(k)} : ${clean(p.type)}`);
			if (p.fields) portLines(p.fields, indent + '  ');
		}
	}
	for (const k of fields(action)) {
		const value = action[k];
		lines.push(`${labels[k]}${value === undefined ? `：${inherit}` : ''}`);
		if (value === undefined) continue;
		if (k === 'inputs' || k === 'outputs') {
			if (Object.keys(action[k]!).length) portLines(action[k]!, '  ');
			else lines.push('  显式空组');
		} else if (k === 'tools') {
			if (!action.tools!.length) lines.push('  无工具');
			for (const t of action.tools!) lines.push(`  ${clean(t)}`);
		} else if (k === 'join') lines.push(`  waitFor / countOn / remaining：${clean(policy(action.join!))}`);
		else for (const line of String(value).split('\n')) lines.push(`  ${clean(line)}`);
	}
	await ctx.ui.custom<void>((tui, theme, kb, done) => {
		let offset = 0,
			page = 1,
			lastWidth = -1,
			wrapped: string[] = [];
		return {
			capturesViewportInput: true,
			render(width: number) {
				if (width < 1) return [];
				if (width !== lastWidth) {
					wrapped = lines.flatMap((s) => wrapTextWithAnsi(s, width));
					lastWidth = width;
				}
				page = Math.max(1, tui.terminal.rows - 9);
				offset = Math.min(Math.max(0, offset), Math.max(0, wrapped.length - page));
				const head = theme.fg('accent', `只读 · ${clean(title)}`);
				const foot = theme.fg(
					'dim',
					`${offset + 1}–${Math.min(wrapped.length, offset + page)}/${wrapped.length} · ↑↓ / PgUp PgDn · Esc 返回`,
				);
				return [head, ...wrapped.slice(offset, offset + page), foot].map((s) => truncateToWidth(s, width, '…'));
			},
			invalidate() {
				lastWidth = -1;
			},
			handleInput(data: string) {
				if (kb.matches(data, 'tui.select.cancel') || kb.matches(data, 'tui.select.confirm')) return done();
				if (kb.matches(data, 'tui.select.up')) offset--;
				else if (kb.matches(data, 'tui.select.down')) offset++;
				else if (matchesKey(data, 'pageUp')) offset -= page;
				else if (matchesKey(data, 'pageDown')) offset += page;
				else return;
				tui.requestRender();
			},
		};
	});
}
