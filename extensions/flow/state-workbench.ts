import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { clean } from './graph-lines.ts';

type StateExit = { to: string | null; when: string; confirm?: boolean };
type StateNode = { instruction?: string; use?: string; exits: StateExit[] };
type StateFlowDraft = {
	mode: 'state';
	name: string;
	context?: string;
	start: string;
	actions: Record<string, StateNode>;
};
type StateActionDraft = { mode: 'state'; instruction: string };
type Draft = StateFlowDraft | StateActionDraft | unknown;

const dict = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => clean(typeof value === 'string' ? value : '');
const errorText = (error: unknown) => clean(error instanceof Error ? error.message : String(error));

/** Labels are views only. Indices keep duplicate or control-character-containing IDs addressable. */
async function pick<T>(
	ctx: ExtensionCommandContext,
	title: string,
	values: readonly T[],
	label: (value: T) => string = String,
): Promise<T | undefined> {
	if (!values.length) throw new Error('没有可选项');
	const labels = values.map(
		(value, index) => `${index + 1}. ${truncateToWidth(clean(label(value)), 180, '…')}`,
	);
	const result = await ctx.ui.select(clean(title), labels);
	return result === undefined ? undefined : values[labels.indexOf(result)];
}

async function newId(ctx: ExtensionCommandContext, title: string, actions: object) {
	const raw = await ctx.ui.input(clean(title));
	if (raw === undefined) return;
	const id = raw.trim();
	if (
		!id ||
		id === 'prototype' ||
		Object.hasOwn(Object.prototype, id) ||
		/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(id)
	)
		throw new Error('名称为空或包含保留字、控制字符');
	if (Object.hasOwn(actions, id)) throw new Error(`名称已存在：${clean(id)}`);
	return id;
}

function exitLabel(exit: StateExit) {
	const target = exit?.to === null ? '完成' : `→ ${text(exit?.to)}`;
	return `${target} · ${text(exit?.when) || '无条件'}${exit?.confirm ? ' · 需确认' : ''}`;
}

export async function stateWorkbench(
	ctx: ExtensionCommandContext,
	kind: 'flow' | 'action',
	name: string,
	initial: unknown,
	save?: (next: unknown) => void,
): Promise<void> {
	if (!ctx.hasUI || (ctx.mode !== 'tui' && ctx.mode !== 'rpc'))
		throw new Error('状态工作台需要 Pi 交互界面');
	const readonly = !save;
	let draft: Draft = structuredClone(initial);
	let dirty = false;
	const title = `${kind === 'flow' ? 'State Flow' : 'State Action'} · ${text(name)} · ${readonly ? '只读' : '编辑'}`;
	const flow = () => draft as StateFlowDraft;
	const action = () => draft as StateActionDraft;
	const actions = () => {
		if (!dict(draft)) throw new Error('Flow 结构无法识别，请先使用完整 JSON 修复');
		const value = flow().actions;
		if (!dict(value)) throw new Error('actions 结构无法识别，请先使用完整 JSON 修复');
		return value as Record<string, StateNode>;
	};
	const changed = () => {
		dirty = true;
	};
	const notifyError = (error: unknown) => ctx.ui.notify(errorText(error), 'error');

	async function leave() {
		if (!dirty || readonly) return true;
		return ctx.ui.confirm('放弃未保存的状态定义草稿？', '选择「否」继续编辑。');
	}

	async function editJSON() {
		let source = JSON.stringify(draft, null, 2);
		for (;;) {
			const next = await ctx.ui.editor(`${title} · 完整 JSON${readonly ? '（只读）' : ''}`, source);
			if (next === undefined || readonly) return;
			source = next;
			try {
				draft = JSON.parse(source);
				changed();
				return;
			} catch (error) {
				notifyError(error);
			}
		}
	}

	async function editContext() {
		if (!dict(draft)) throw new Error('Flow 结构无法识别，请先使用完整 JSON 修复');
		const before = typeof flow().context === 'string' ? flow().context : '';
		const next = await ctx.ui.editor(`${title} · 共同背景${readonly ? '（只读）' : ''}`, before);
		if (next === undefined || readonly || next === before) return;
		flow().context = next;
		changed();
	}

	async function editStart() {
		const ids = Object.keys(actions());
		const current = flow().start;
		const next = await pick(ctx, '选择起点状态', [current, ...ids.filter((id) => id !== current)]);
		if (next === undefined || readonly || next === current) return;
		flow().start = next;
		changed();
	}

	async function editExit(current?: StateExit): Promise<StateExit | undefined> {
		const ids = Object.keys(actions());
		const targets: (string | null)[] = current
			? [current.to, ...[null, ...ids].filter((id) => id !== current.to)]
			: [null, ...ids];
		const to = await pick(ctx, '出口目标 · 完成表示显式结束', targets, (id) =>
			id === null ? '完成' : `状态 ${id}`,
		);
		if (to === undefined) return;
		const when = await ctx.ui.editor('出口条件 · 主模型按普通条件语义判断', current?.when ?? '');
		if (when === undefined) return;
		const protection = await pick(
			ctx,
			'出口保护',
			current?.confirm ? (['protected', 'plain', 'cancel'] as const) : (['plain', 'protected', 'cancel'] as const),
			(value) =>
				value === 'protected'
					? '受保护 · 每次经过都必须由用户确认'
					: value === 'plain'
						? '普通 · 主模型自行判断条件'
						: '取消，不修改出口',
		);
		if (protection === undefined || protection === 'cancel') return;
		return { to, when, ...(protection === 'protected' ? { confirm: true } : {}) };
	}

	async function browseExits(node: StateNode) {
		if (!Array.isArray(node.exits)) throw new Error('exits 结构无法识别，请先使用完整 JSON 修复');
		for (;;) {
			const add = Symbol('add');
			const values: (number | typeof add)[] = [
				...(readonly ? [] : ([add] as const)),
				...node.exits.map((_exit, index) => index),
			];
			if (!values.length) {
				await pick(ctx, '出口', ['暂无出口']);
				return;
			}
			const selected = await pick(ctx, `出口 · ${node.exits.length} 条`, values, (value) =>
				value === add ? '添加出口…' : exitLabel(node.exits[value]),
			);
			if (selected === undefined) return;
			if (selected === add) {
				const next = await editExit();
				if (next) {
					node.exits.push(next);
					changed();
				}
				continue;
			}
			const index = selected;
			const current = node.exits[index];
			if (readonly) {
				await ctx.ui.editor('出口（只读）', JSON.stringify(current, null, 2));
				continue;
			}
			const op = await pick(ctx, exitLabel(current), ['edit', 'delete'], (value) =>
				value === 'edit' ? '编辑目标 / 条件 / 保护' : '删除出口',
			);
			if (op === 'edit') {
				const next = await editExit(current);
				if (next) {
					node.exits[index] = next;
					changed();
				}
			} else if (op === 'delete') {
				if (await ctx.ui.confirm('删除出口？', clean(exitLabel(current)))) {
					node.exits.splice(index, 1);
					changed();
				}
			} else return;
		}
	}

	async function addNode() {
		const all = actions();
		const id = await newId(ctx, '新状态 ID', all);
		if (!id) return;
		const nodeKind = await pick(ctx, '状态类型', ['inline', 'global'] as const, (value) =>
			value === 'inline' ? '内联指令' : '引用全局 State Action（精确名称）',
		);
		if (nodeKind === undefined) return;
		let node: StateNode;
		if (nodeKind === 'inline') {
			const instruction = await ctx.ui.editor(`${id} · 状态指令`, '');
			if (instruction === undefined) return;
			node = { instruction, exits: [] };
		} else {
			const use = await ctx.ui.input(`${id} · 全局 Action 精确名称（不要添加 global:）`);
			if (use === undefined) return;
			node = { use, exits: [] };
		}
		all[id] = node;
		changed();
	}

	async function renameNode(id: string) {
		const all = actions();
		const next = await newId(ctx, '状态新 ID', all);
		if (!next) return;
		all[next] = all[id];
		delete all[id];
		if (flow().start === id) flow().start = next;
		for (const node of Object.values(all))
			if (Array.isArray(node.exits)) for (const exit of node.exits) if (exit.to === id) exit.to = next;
		changed();
	}

	async function removeNode(id: string) {
		if (flow().start === id) throw new Error('起点状态不能直接删除，请先更换起点');
		if (!(await ctx.ui.confirm('删除状态？', `${text(id)} · 指向它的出口也会删除`))) return;
		const all = actions();
		delete all[id];
		for (const node of Object.values(all))
			if (Array.isArray(node.exits)) node.exits = node.exits.filter((exit) => exit.to !== id);
		changed();
	}

	async function convertNode(node: StateNode) {
		if (typeof node.instruction === 'string') {
			const use = await ctx.ui.input('全局 Action 精确名称（不要添加 global:）');
			if (use === undefined) return;
			delete node.instruction;
			node.use = use;
		} else {
			const instruction = await ctx.ui.editor('内联状态指令', '');
			if (instruction === undefined) return;
			delete node.use;
			node.instruction = instruction;
		}
		changed();
	}

	async function browseNode(id: string) {
		for (;;) {
			const node = actions()[id];
			if (!dict(node)) throw new Error('状态结构无法识别，请先使用完整 JSON 修复');
			const inline = typeof node.instruction === 'string';
			const values = readonly
				? ['instruction', 'exits']
				: ['instruction', 'exits', 'convert', 'rename', 'delete'];
			const op = await pick(ctx, `状态 ${id} · ${inline ? '内联' : `use ${text(node.use)}`}`, values, (value) => {
				if (value === 'instruction') return inline ? '状态指令' : '全局 Action 引用';
				if (value === 'exits') return `直接出口 · ${Array.isArray(node.exits) ? node.exits.length : '?'} 条`;
				if (value === 'convert') return inline ? '改为全局 Action 引用' : '改为内联指令';
				return value === 'rename' ? '重命名（同步起点和出口）' : '删除状态';
			});
			if (op === undefined) return;
			if (op === 'instruction') {
				if (inline) {
					const before = node.instruction ?? '';
					const next = await ctx.ui.editor(`${id} · 状态指令${readonly ? '（只读）' : ''}`, before);
					if (next !== undefined && !readonly && next !== before) {
						node.instruction = next;
						changed();
					}
				} else if (readonly) {
					await ctx.ui.editor('全局 Action 引用（只读）', text(node.use));
				} else {
					const next = await ctx.ui.input(`${id} · 全局 Action 精确名称`, text(node.use));
					if (next !== undefined && next !== node.use) {
						node.use = next;
						changed();
					}
				}
			} else if (op === 'exits') await browseExits(node);
			else if (op === 'convert') await convertNode(node);
			else if (op === 'rename') {
				await renameNode(id);
				return;
			} else if (op === 'delete') {
				await removeNode(id);
				return;
			}
		}
	}

	async function browseNodes() {
		for (;;) {
			const all = actions();
			const add = Symbol('add');
			const values: (string | typeof add)[] = [...(readonly ? [] : ([add] as const)), ...Object.keys(all)];
			if (!values.length) {
				await pick(ctx, '状态节点', ['暂无状态']);
				return;
			}
			const selected = await pick(ctx, `状态节点 · 起点 ${text(flow().start) || '未设置'}`, values, (value) => {
				if (value === add) return '添加状态…';
				const node = all[value];
				return `${value}${flow().start === value ? ' · 起点' : ''} · ${
					typeof node?.instruction === 'string' ? '内联' : `use ${text(node?.use)}`
				}`;
			});
			if (selected === undefined) return;
			if (selected === add) await addNode();
			else await browseNode(selected);
		}
	}

	for (;;) {
		try {
			const isFlow = kind === 'flow';
			const values = isFlow
				? [...(readonly ? [] : ['start']), 'nodes', 'context', 'json', ...(readonly ? [] : ['save']), 'exit']
				: ['instruction', 'json', ...(readonly ? [] : ['save']), 'exit'];
			const picked = await pick(ctx, title, values, (value) => {
				if (value === 'start') return `起点 · ${dict(draft) ? text(flow().start) || '未设置' : '未设置'}`;
				if (value === 'nodes')
					return `状态节点与直接出口 · ${dict(draft) && dict(flow().actions) ? Object.keys(flow().actions).length : '?'} 个`;
				if (value === 'context') return '共同背景';
				if (value === 'instruction') return '状态指令';
				if (value === 'json') return `完整 JSON${readonly ? '（只读）' : '编辑'}`;
				if (value === 'save') return dirty ? '校验并保存 ●' : '校验并保存';
				return '退出工作台';
			});
			const op = picked ?? 'exit';
			if (op === 'exit') {
				if (await leave()) return;
			} else if (op === 'save' && save) {
				// The owner validates storage revision/session epoch and the complete state contract.
				save(structuredClone(draft));
				ctx.ui.notify(`已保存 ${text(name)}`, 'info');
				return;
			} else if (op === 'json') await editJSON();
			else if (op === 'context') await editContext();
			else if (op === 'start' && !readonly) await editStart();
			else if (op === 'nodes') await browseNodes();
			else if (op === 'instruction') {
				const before = typeof action().instruction === 'string' ? action().instruction : '';
				const next = await ctx.ui.editor(`${title} · 状态指令${readonly ? '（只读）' : ''}`, before);
				if (next !== undefined && !readonly && next !== before) {
					action().instruction = next;
					changed();
				}
			}
		} catch (error) {
			notifyError(error);
		}
	}
}
