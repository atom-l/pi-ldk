import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { compile, resolveUse, type Action, type Flow } from './contract.ts';
import { editAction } from './actions-ui.ts';
import { clean } from './graph-lines.ts';
import { boardScreen, edgeText, errorText, properties, type Board, type BoardKey } from './workbench-view.ts';

const builtins = ['action', 'task', 'start', 'end', 'decision', 'gate', 'fork', 'join'].map((k) => 'builtin:' + k);
type Options = { readonly: boolean; root: string; save: (v: Flow) => void };
const ops = {
	jump: '跳到节点  j',
	add: '添加节点  a',
	edit: '编辑节点属性 / 内联继承  e',
	ref: '替换为命名引用',
	rename: '重命名节点（同步连线）',
	remove: '删除节点及相邻连线',
	link: '从此节点连接端口  l',
	unlink: '删除连线  x',
	local: '本地 Actions  c',
	save: '校验并保存  s / Ctrl+S',
	exit: '退出工作台',
} as const;
type Op = keyof typeof ops;

/** Keep display labels separate from stored IDs: a control character, or even two
 * different strings that normalize to the same display text, must not misroute an edit. */
async function pick<T>(
	ctx: ExtensionCommandContext,
	title: string,
	values: T[],
	label: (v: T) => string = String,
): Promise<T | undefined> {
	if (!values.length) throw new Error('没有可选项');
	const labels = values.map((v, i) => `${i + 1}. ${clean(truncateToWidth(clean(label(v)), 180, '…'))}`);
	const result = await ctx.ui.select(clean(title), labels);
	return result === undefined ? undefined : values[labels.indexOf(result)];
}

async function newId(ctx: ExtensionCommandContext, title: string, obj: object, local = false) {
	const raw = await ctx.ui.input(title);
	if (raw === undefined) return;
	const id = raw.trim();
	if (
		!id ||
		id === 'prototype' ||
		Object.hasOwn(Object.prototype, id) ||
		/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(id) ||
		(local && id.includes(':'))
	)
		throw new Error('名称为空或包含保留字、控制字符或无效分隔符');
	if (Object.hasOwn(obj, id)) throw new Error(`名称已存在：${clean(id)}`);
	return id;
}

/** Minimal shape check for hand-edited storage. Missing references, ports, nodes and
 * inheritance cycles are repairable here; unrecognizable containers need /flow json. */
function assertShape(flow: Flow) {
	const dict = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
	const pair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((s) => typeof s === 'string');
	if (
		!dict(flow) ||
		!dict(flow.nodes) ||
		(flow.actions !== undefined && !dict(flow.actions)) ||
		Object.values(flow.nodes).some((n) => !dict(n) || (typeof n.use !== 'string' && !dict(n.use))) ||
		!Array.isArray(flow.edges) ||
		flow.edges.some((e) => !e || !pair(e.from) || !pair(e.to))
	)
		throw new Error('流程结构无法识别。请使用 /flow json 名称 修复 nodes / edges / actions。');
}

export async function flowWorkbench(
	ctx: ExtensionCommandContext,
	flow: Flow,
	globals: Record<string, Action>,
	options: Options,
): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('Flow 工作台需要 Pi 终端界面');
	assertShape(flow);
	const draft = structuredClone(flow),
		state: Board = { page: 0, detail: false, dirty: false };
	const session = ctx.sessionManager.getSessionId(),
		cwd = ctx.cwd,
		leaf = ctx.sessionManager.getLeafId();
	const refs = () => [
		...builtins,
		...Object.keys(globals).map((k) => 'global:' + k),
		...Object.keys(draft.actions ?? {}).map((k) => 'local:' + k),
	];
	const resolve = (id: string) => resolveUse(draft.nodes[id].use, globals, draft.actions ?? {});
	const changed = () => {
		state.dirty = true;
		state.error = undefined;
	};
	const setNode = (id: string, use: string | Action) => {
		draft.nodes[id] = { use };
		state.selected = id;
		state.page = 0;
		changed();
	};

	async function localActions() {
		const actions = draft.actions ?? {},
			ids = Object.keys(actions);
		if (options.readonly && !ids.length) throw new Error('没有本地 Action');
		// Use a sentinel, not a magic user-addressable display string.
		const add = Symbol('add');
		const target = await pick<string | typeof add>(ctx, '本地 Actions', options.readonly ? ids : [add, ...ids], (s) =>
			s === add ? '新建本地 Action…' : 'local:' + s,
		);
		if (target === undefined) return;
		if (target === add) {
			const id = await newId(ctx, '本地 Action 名称', actions, true);
			if (!id) return;
			const next = await editAction(ctx, { extends: 'builtin:action' }, refs());
			if (next) {
				(draft.actions ??= {})[id] = next;
				changed();
			}
			return;
		}
		const ref = 'local:' + target,
			spec = actions[target];
		const choice = options.readonly
			? '查看继承属性'
			: await ctx.ui.select(clean(ref), ['编辑属性', '查看继承属性', '重命名', '删除']);
		if (choice === '编辑属性') {
			const next = await editAction(
				ctx,
				structuredClone(spec),
				refs().filter((v) => v !== ref),
			);
			if (next) {
				actions[target] = next;
				changed();
			}
		} else if (choice === '查看继承属性') {
			await pick(ctx, `${ref} · 继承 ${clean(spec?.extends)}`, properties(resolveUse(ref, globals, actions)));
		} else if (choice === '重命名' || choice === '删除') {
			const aliases = Object.values(actions).filter((a) => a?.extends === ref);
			const users = Object.values(draft.nodes).filter(
				(n) => n.use === ref || (typeof n.use === 'object' && n.use.extends === ref),
			);
			if (choice === '删除') {
				if (aliases.length || users.length)
					throw new Error(`${ref} 仍有 ${aliases.length + users.length} 个引用；请先替换引用。`);
				if (!(await ctx.ui.confirm('删除本地 Action？', clean(ref)))) return;
			} else {
				const id = await newId(ctx, '本地 Action 新名称', actions, true);
				if (!id) return;
				actions[id] = spec;
				for (const a of aliases) a.extends = 'local:' + id;
				for (const n of users) {
					if (typeof n.use === 'string') n.use = 'local:' + id;
					else n.use.extends = 'local:' + id;
				}
			}
			delete actions[target];
			changed();
		}
	}

	for (;;) {
		const key: BoardKey = await boardScreen(ctx, draft, state, options.readonly, resolve, options.root);
		const id = state.selected,
			hasNode = id !== undefined && Object.hasOwn(draft.nodes, id);
		try {
			let op: Op | undefined;
			if (key === 'menu') {
				const choices: Op[] = options.readonly
					? ['jump', 'local', 'exit']
					: [
							'add',
							...(hasNode ? (['edit', 'ref', 'rename', 'remove', 'link'] as const) : []),
							'unlink',
							'jump',
							'local',
							'save',
							'exit',
						];
				op = await pick(ctx, '工作台操作', choices, (k) => ops[k]);
			} else op = key;
			if (!op) continue;
			if (op === 'exit') {
				if (!state.dirty || (await ctx.ui.confirm('放弃未保存的 Flow 草稿？', '选择「否」继续编辑。'))) return;
			} else if (op === 'jump') {
				const next = await pick(ctx, '跳到节点', Object.keys(draft.nodes));
				if (next !== undefined) {
					state.selected = next;
					state.page = 0;
				}
			} else if (op === 'local') await localActions();
			else if (options.readonly) continue;
			else if (op === 'save') {
				if (
					ctx.cwd !== cwd ||
					ctx.sessionManager.getSessionId() !== session ||
					(leaf &&
						ctx.sessionManager.getLeafId() !== leaf &&
						!ctx.sessionManager.getBranch().some((e) => e.id === leaf))
				)
					throw new Error('会话或分支已改变，未保存。请重新打开工作台。');
				compile(draft, globals);
				// The command owner compares storage revision and session epoch, then
				// revalidates against current globals immediately before its atomic put.
				options.save(structuredClone(draft));
				ctx.ui.notify(clean(`已保存 ${draft.name} · ${options.root}`), 'info');
				return;
			} else if (op === 'add') {
				const next = await newId(ctx, '新节点 ID', draft.nodes);
				if (!next) continue;
				const use = await pick(ctx, '节点使用的 Action', refs());
				if (use !== undefined) setNode(next, use);
			} else if (op === 'unlink') {
				const e = await pick(ctx, '删除哪条连线？', draft.edges, edgeText);
				if (e) {
					draft.edges.splice(draft.edges.indexOf(e), 1);
					changed();
				}
			} else if (!hasNode) throw new Error('请先添加节点');
			else if (op === 'ref') {
				const next = await pick(ctx, '替换 use 引用（移除内联覆盖）', refs());
				if (next) setNode(id, next);
			} else if (op === 'edit') {
				const use = draft.nodes[id].use;
				const initial = typeof use === 'string' ? { extends: use } : use;
				const next = await editAction(ctx, structuredClone(initial), refs());
				if (next && JSON.stringify(initial) !== JSON.stringify(next)) setNode(id, next);
			} else if (op === 'rename') {
				const next = await newId(ctx, '节点新 ID', draft.nodes);
				if (!next) continue;
				setNode(next, draft.nodes[id].use);
				delete draft.nodes[id];
				for (const e of draft.edges) {
					if (e.from[0] === id) e.from[0] = next;
					if (e.to[0] === id) e.to[0] = next;
				}
			} else if (op === 'remove') {
				if (!(await ctx.ui.confirm('删除节点及所有相邻连线？', clean(id)))) continue;
				delete draft.nodes[id];
				draft.edges = draft.edges.filter((e) => e.from[0] !== id && e.to[0] !== id);
				state.selected = undefined;
				state.detail = false;
				state.page = 0;
				changed();
			} else if (op === 'link') {
				const outputs = resolve(id).outputs;
				const port = await pick(
					ctx,
					`${id} · 选择输出端口`,
					Object.keys(outputs),
					(k) => `${k} : ${outputs[k].type}`,
				);
				if (port === undefined) continue;
				const target = await pick(
					ctx,
					'目标节点',
					Object.keys(draft.nodes).filter((n) => n !== id),
				);
				if (target === undefined) continue;
				const inputs = resolve(target).inputs;
				const dest = await pick(
					ctx,
					`${target} · 选择输入端口`,
					Object.keys(inputs),
					(k) => `${k} : ${inputs[k].type}`,
				);
				if (dest === undefined) continue;
				if (
					draft.edges.some((e) => e.from[0] === id && e.from[1] === port && e.to[0] === target && e.to[1] === dest)
				)
					throw new Error('连线已存在');
				draft.edges.push({ from: [id, port], to: [target, dest] });
				changed();
			}
		} catch (e) {
			state.error = errorText(e);
			ctx.ui.notify(state.error, 'error');
		}
	}
}
