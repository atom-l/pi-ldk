import { readFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { compile, validateAction, type Action, type Flow } from './contract.ts';
import { archiveFlow, flowRevision, globalsFor, listDefs, readDef, readSnapshot, rootFor, saveSnapshot } from './store.ts';
import { compileState, isStateDefinition, validateStateAction } from './state-contract.ts';
import { stateBook } from './state-runtime.ts';
import { stateWorkbench } from './state-workbench.ts';
import { runBook } from './runs.ts';
import { clean, diagramFrom } from './graph-lines.ts';
import { flowWorkbench } from './workbench.ts';
import { editAction, viewAction } from './actions-ui.ts';
import { showRun, type RunFrame } from './run-board.ts';
import { presentDefinition, presentRun, toolHeading, toolText } from './tool-cards.ts';

type Kind = 'action' | 'flow';
const kindParam = Type.Union([Type.Literal('flow'), Type.Literal('action')]);
const nameParam = Type.String({ description: 'Exact definition name in this config root.' });
const format = (value: unknown) => JSON.stringify(value, null, 2);
const text = (value: unknown) => ({
	content: [{ type: 'text' as const, text: typeof value === 'string' ? value : format(value) }],
	details: {},
});
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
// The list is a view: sanitizing its labels must not change the referenced definition.
async function chooseName(
	ctx: ExtensionCommandContext,
	title: string,
	names: string[],
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (!names.length) return undefined;
	const labels = names.map((n, i) => `${i + 1}. ${clean(n)}`);
	const picked = await ctx.ui.select(clean(title), labels, signal ? { signal } : undefined);
	return picked === undefined ? undefined : names[labels.indexOf(picked)];
}
export function extractFlowGuide(markdown: string): string {
	const marks = [...markdown.matchAll(/^<!-- ldk:flow-guide:(start|end) -->\r?$/gm)];
	const [start, end] = marks;
	if (marks.length !== 2 || start[1] !== 'start' || end[1] !== 'end') {
		throw new Error('Invalid Flow guide markers in the LDK package README.md.');
	}
	const guide = markdown.slice(start.index + start[0].length, end.index).trim();
	if (!guide) throw new Error('Empty Flow guide in the LDK package README.md.');
	return guide;
}

function starter(kind: Kind, name: string, legacy: boolean): unknown {
	if (!legacy) {
		const instruction = '在主会话中完成约定的工作，并核对结果。';
		return kind === 'action' ? { mode: 'state', instruction } : {
			mode: 'state', name, context: '', start: '工作',
			actions: { 工作: { instruction, exits: [{ to: null, when: '本次约定的工作已完成。' }] } },
		};
	}
	if (kind === 'action') return { extends: 'builtin:action', template: '将 in 消息原样返回到 out 端口。' };
	return {
		name,
		nodes: { start: { use: 'builtin:start' }, end: { use: 'builtin:end' } },
		edges: [{ from: ['start', 'out'], to: ['end', 'in'] }],
	};
}
function statePlan(root: string, name: string, value: unknown) {
	const plan = compileState(value, (ref) => readDef(root, 'action', ref));
	if (plan.name !== name) throw new Error('State Flow.name must match its stored name.');
	return plan;
}
function put(root: string, kind: Kind, name: string, value: unknown, expectedRevision?: string | null) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Definition must be a JSON object.');
	const state = isStateDefinition(value);
	if (kind === 'flow') {
		if ((value as Flow).name !== name) throw new Error('Flow.name must match the name being saved.');
		if (state) statePlan(root, name, value);
		else compile(value, globalsFor(root));
	} else if (state) validateStateAction(value);
	else validateAction(name, value as Action, { ...globalsFor(root), [name]: value as Action });
	saveSnapshot(root, kind, name, value, expectedRevision);
	return { root, kind, name, saved: true, ...(state ? { mode: 'state' } : {}) };
}

/** Explicit raw mode, also used by RPC clients that only provide Pi's basic editor. */
async function jsonEditor(
	ctx: ExtensionCommandContext,
	root: string,
	kind: Kind,
	name: string,
	initial: unknown,
	save: (v: unknown) => void,
) {
	let draft = format(initial);
	for (;;) {
		const next = await ctx.ui.editor(`编辑 ${kind} · ${clean(name)} · ${clean(root)}`, draft);
		if (next === undefined) return;
		draft = next;
		try {
			save(JSON.parse(draft));
		} catch (e) {
			ctx.ui.notify(clean(err(e)), 'error');
			continue;
		}
		ctx.ui.notify(`已保存 ${clean(name)} · ${clean(root)}`, 'info');
		return;
	}
}

export default function flowExtension(pi: ExtensionAPI) {
	const runs = runBook(pi);
	const states = stateBook(pi);
	const listRuns = (ctx: ExtensionContext) => [
		...(runs.inspect(ctx) as { id: string; name: string; phase: string }[]), ...states.inspect(ctx),
	];
	const cancelRun = (ctx: ExtensionContext, id: string) => states.owns(ctx, id) ? states.cancel(ctx, id) : runs.cancel(id);
	let pinnedRoot: string | undefined;
	let epoch = 0;
	let scope = new AbortController();
	function invalidateScope() {
		epoch++;
		scope.abort();
		scope = new AbortController();
	}
	// A directory created during a run by another tool does not silently move the editor.
	const storage = (ctx: ExtensionContext) => (pinnedRoot ??= rootFor(ctx));
	pi.on('session_start', () => {
		invalidateScope();
		pinnedRoot = undefined;
	});
	pi.on('session_tree', invalidateScope);
	pi.on('session_shutdown', invalidateScope);
	const renderRun = presentRun(runs);
	pi.registerTool({
		name: 'flow_guide',
		label: 'Flow: definition guide',
		description:
			'Read before authoring a Flow or Action. Includes the main-session state machine contract and example, and a separate compatibility guide for legacy port graphs.',
		parameters: Type.Object({}),
		execute: async () => text(extractFlowGuide(readFileSync(new URL('../../README.md', import.meta.url), 'utf8'))),
	});
	pi.registerTool({
		name: 'flow_inspect',
		label: 'Flow: view definitions',
		renderCall: toolHeading('查看定义'),
		renderResult: presentDefinition,
		description:
			'List names in the session config root by omitting name or passing "". Pass an exact name from the list to read its complete definition. Local and anonymous actions are inside their owning flow.',
		parameters: Type.Object({
			kind: kindParam,
			name: Type.Optional(
				Type.String({ description: 'Omit or pass "" to list names; otherwise use the exact definition name.' }),
			),
		}),
		execute: async (_id, { kind, name }, _s, _u, ctx) => {
			const root = storage(ctx);
			return text(
				name === undefined || name === ''
					? { root, kind, names: listDefs(root, kind) }
					: { root, kind, name, definition: readDef(root, kind, name) },
			);
		},
	});
	pi.registerTool({
		name: 'flow_define',
		label: 'Flow: save definition',
		renderCall: toolHeading('保存定义'),
		renderResult: presentDefinition,
		description:
			'Save a complete named Flow or global Action. Use mode:"state" for a workflow driven by the current conversation. Read flow_guide for the schema. Saving never executes work, converts formats or changes a running snapshot.',
		parameters: Type.Object({
			kind: kindParam,
			name: nameParam,
			definition: Type.Object(
				{},
				{ additionalProperties: true, description: 'Complete Flow or Action JSON object; see flow_guide.' },
			),
		}),
		execute: async (_id, p, _s, _u, ctx) =>
			toolText(
				put(storage(ctx), p.kind, p.name, p.definition),
				p.kind === 'flow' && !isStateDefinition(p.definition) ? { diagram: diagramFrom(p.definition as Flow) } : {},
			),
	});
	function requireDeleteUI(ctx: ExtensionContext) {
		if (!ctx.hasUI || (ctx.mode !== 'tui' && ctx.mode !== 'rpc'))
			throw new Error('删除 Flow 需要用户在交互界面确认；未更改任何定义。');
	}
	// Both entry points act on the same revision the user was asked about, never on a run ID.
	async function confirmArchive(ctx: ExtensionContext, root: string, name: string, signal: AbortSignal) {
		requireDeleteUI(ctx);
		signal.throwIfAborted();
		const version = flowRevision(root, name);
		const confirm = '移到回收目录';
		const shown = clean(name);
		const title = [
			`删除 Flow：${shown}`,
			...(shown === name ? [] : [`名称的 UTF-8 编码：${Buffer.from(name).toString('hex')}`]),
			`配置根：${clean(root)}`,
			'仅移出活动定义；文件保留，已有运行、历史记录和全局 Action 不变。',
		].join('\n');
		const choice = await ctx.ui.select(title, ['取消', confirm], { signal, blockedKind: 'permission' });
		signal.throwIfAborted();
		const result = { root, kind: 'flow' as const, name };
		if (choice !== confirm) return { ...result, deleted: false as const };
		return { ...result, deleted: true as const, archivePath: archiveFlow(root, name, version) };
	}
	pi.registerTool({
		name: 'flow_delete',
		label: 'Flow: archive definition',
		description:
			'Request user confirmation to move one exact named Flow definition out of the active catalog into recoverable storage. Does not purge files, cancel runs, delete history, or delete global Actions. No force or bulk mode.',
		exposure: 'model-only',
		executionMode: 'sequential',
		annotations: { readOnlyHint: false, destructiveHint: true },
		parameters: Type.Object({ name: nameParam }, { additionalProperties: false }),
		execute: async (_id, { name }, s, _u, ctx) => {
			const abort = s ?? ctx.signal;
			return text(
				await confirmArchive(ctx, storage(ctx), name, abort ? AbortSignal.any([scope.signal, abort]) : scope.signal),
			);
		},
	});
	pi.registerTool({
		name: 'flow_run',
		label: 'Flow: run',
		reachesTools: () => 'all',
		renderCall: toolHeading('运行流程'),
		renderResult: renderRun,
		exposure: 'model-only',
		description:
			'Start a named Flow. A state Flow only enters its first Action; do the work in this conversation, stay there as long as needed, then use flow_step for one declared exit. Do not restart an active Flow. Only legacy port graphs execute workers and take typed input.',
		parameters: Type.Object({
			name: nameParam,
			input: Type.Optional(
				Type.Object(
					{},
					{ additionalProperties: true, description: 'Legacy port graphs only: initial port messages. Omit this field entirely for a state Flow.' },
				),
			),
		}),
		execute: async (_id, p, s, update, ctx) => {
			const root = storage(ctx);
			const definition = readDef(root, 'flow', p.name);
			if (isStateDefinition(definition)) {
				if (p.input !== undefined) throw new Error('State Flows use the main conversation, not legacy port input.');
				(s ?? ctx.signal)?.throwIfAborted();
				return toolText(states.start(ctx, statePlan(root, p.name, definition)));
			}
			const graph = compile(definition, globalsFor(root));
			const progress =
				ctx.mode === 'tui' && update
					? (frame: RunFrame) => update(toolText(`${frame.name} · ${frame.phase}`, { frame }))
					: undefined;
			const result = await runs.launch(ctx, graph, p.input, s, progress);
			return toolText(
				result,
				{ frame: runs.views.get(result.id) },
				result.phase === 'failed' || result.phase === 'cancelled',
			);
		},
	});
	pi.registerTool({
		name: 'flow_step', label: 'Flow: advance one state', exposure: 'model-only', executionMode: 'sequential',
		renderCall: toolHeading('申请流转'), renderResult: renderRun,
		description: 'Propose exactly one direct exit of the current state Flow. Use the id, revision and from returned by flow_run or flow_status. A null target finishes only on a declared completion exit. Explain the evidence in reason. A protected exit requires the full concrete proposal for this transition. Never infer approval from chat or retry a declined proposal unprompted.',
		parameters: Type.Object({
			id: Type.String(), revision: Type.Integer({ minimum: 0 }), from: Type.String(),
			to: Type.Union([Type.String(), Type.Null()]), reason: Type.String({ minLength: 1, maxLength: 4096 }),
			proposal: Type.Optional(Type.String({ maxLength: 16384, description: 'Full, specific content to put before the user for this transition.' })),
		}, { additionalProperties: false }),
		execute: async (_id, p, s, _u, ctx) => toolText(await states.step(ctx, p, s ?? ctx.signal)),
	});
	pi.registerTool({
		name: 'flow_continue',
		label: 'Flow: continue',
		reachesTools: () => 'all',
		renderCall: toolHeading('继续流程'),
		renderResult: renderRun,
		exposure: 'model-only',
		description:
			'Reattach a live caller to the same Flow after a deferred gate or a requested host-only tool. For a host request, pass requestId after the real top-level call, plus toolCallId if needed. Do not retry a side effect. Does not approve a gate or restart actions.',
		parameters: Type.Object({
			id: Type.String(),
			requestId: Type.Optional(Type.String()),
			toolCallId: Type.Optional(Type.String()),
		}),
		execute: async (callId, p, s, update, ctx) => {
			if (states.owns(ctx, p.id)) throw new Error('Use flow_step for a state Flow; flow_continue is for legacy port graphs.');
			const tick =
				ctx.mode === 'tui' && update
					? (frame: RunFrame) => update(toolText(`${frame.name} · ${frame.phase}`, { frame }))
					: undefined;
			const unsubscribe = tick && runs.views.watch(p.id, `continue:${callId}`, tick);
			try {
				const start = tick && runs.views.get(p.id);
				if (start && tick) tick(start);
				return toolText(await runs.resume(ctx, p.id, s, p.requestId, p.toolCallId), { frame: runs.views.get(p.id) });
			} finally {
				unsubscribe?.();
			}
		},
	});
	pi.registerTool({
		name: 'flow_status',
		label: 'Flow: run status',
		renderCall: toolHeading('流程状态'),
		renderResult: renderRun,
		description:
			'Inspect this branch’s Flow runs. Pass id to get the state Flow’s current Action, revision and legal exits, or a legacy run’s journal.',
		parameters: Type.Object({ id: Type.Optional(Type.String()) }),
		execute: async (_id, p, _s, _u, ctx) => {
			if (!p.id) return toolText(listRuns(ctx));
			if (states.owns(ctx, p.id)) return toolText(states.inspect(ctx, p.id));
			return toolText(runs.inspect(ctx, p.id), { frame: runs.views.get(p.id, false, ctx) });
		},
	});
	pi.registerTool({
		name: 'flow_cancel',
		label: 'Flow: cancel run',
		description:
			'Request cancellation of an active run including unfinished workers. Does not undo completed side effects.',
		parameters: Type.Object({ id: Type.String() }),
		execute: async (_id, p, _s, _u, ctx) => text(cancelRun(ctx, p.id)),
	});

	async function deleteCommand(ctx: ExtensionCommandContext, root: string, specified?: string) {
		requireDeleteUI(ctx);
		const signal = scope.signal;
		let name = specified;
		if (!name) {
			const names = listDefs(root, 'flow');
			if (!names.length) {
				ctx.ui.notify('尚无可删除的 Flow 定义', 'info');
				return;
			}
			name = await chooseName(ctx, `选择要删除的 Flow · ${root}`, names, signal);
			if (!name) return;
		}
		const r = await confirmArchive(ctx, root, name, signal);
		ctx.ui.notify(r.deleted ? `已移到回收目录：${clean(r.archivePath)}` : '已取消，Flow 定义未更改。', 'info');
	}
	async function browse(ctx: ExtensionCommandContext, root: string, kind: Kind, name: string) {
		const v = readDef(root, kind, name);
		if (ctx.mode !== 'tui') {
			show(ctx, { root, definition: v });
			return;
		}
		if (isStateDefinition(v)) return stateWorkbench(ctx, kind, name, v);
		if (kind === 'flow')
			await flowWorkbench(ctx, v as Flow, globalsFor(root), {
				readonly: true,
				root,
				save: () => {
					throw new Error('只读');
				},
			});
		else await viewAction(ctx, v as Action, name);
	}
	async function editDefinition(
		ctx: ExtensionCommandContext,
		root: string,
		kind: Kind,
		name: string,
		create: boolean,
		revision: number,
		raw = false,
		legacy = false,
	) {
		if (revision !== epoch) throw new Error('会话或分支已切换，请重新打开。');
		if (create && listDefs(root, kind).includes(name)) throw new Error(`Already exists: ${name}`);
		const snapshot = create ? undefined : readSnapshot(root, kind, name);
		const save = (v: unknown) => {
			if (epoch !== revision) throw new Error('会话或分支已切换，未保存。');
			put(root, kind, name, v, snapshot?.revision ?? null);
		};
		let draft = structuredClone(snapshot?.definition ?? starter(kind, name, legacy));
		if (raw || ctx.mode !== 'tui') return jsonEditor(ctx, root, kind, name, draft, save);
		if (isStateDefinition(draft)) return stateWorkbench(ctx, kind, name, draft, (v) => {
			if (!isStateDefinition(v)) throw new Error('状态定义必须保留 mode:"state"；旧图请使用 new-graph。');
			save(v);
		});
		const globals = globalsFor(root);
		if (kind === 'flow') return flowWorkbench(ctx, draft as Flow, globals, { readonly: false, root, save });
		for (;;) {
			const next = await editAction(
				ctx,
				draft as Action,
				Object.keys(globals)
					.filter((n) => n !== name)
					.map((n) => `global:${n}`),
				`${name} · ${root}`,
			);
			if (!next) return;
			draft = next;
			try {
				save(next);
			} catch (e) {
				ctx.ui.notify(clean(err(e)), 'error');
				if (epoch !== revision) return;
				continue;
			}
			ctx.ui.notify(`已保存 ${clean(name)}`, 'info');
			return;
		}
	}
	for (const kind of ['flow', 'action'] as const)
		pi.registerCommand(kind, {
			description:
				kind === 'flow'
					? '管理主会话状态机和旧版流程图；/flow start 名称 进入起点，/flow status 查看进度。'
					: '查看、新建或编辑全局 Action；Flow 专有 Action 在 /flow 内编辑。',
			handler: async (args, ctx) => {
				try {
					const root = storage(ctx),
						revision = epoch;
					const [, op = '', arg = ''] = /^(\S+)?(?:\s+([\s\S]*))?$/.exec(args.trim())!;
					if (kind === 'flow' && op === 'delete') {
						await deleteCommand(ctx, root, arg || undefined);
						return;
					}
					if (kind === 'flow' && op === 'start') {
						const definition = readDef(root, kind, arg);
						if (!isStateDefinition(definition)) throw new Error('该定义是旧版执行图，请用 flow_run 运行。');
						show(ctx, states.start(ctx, statePlan(root, arg, definition)));
						return;
					}
					if (kind === 'flow' && op === 'answer') {
						if (states.owns(ctx, arg)) throw new Error('状态机由主会话使用 flow_step 申请具体流转；此命令只回答旧版关口。');
						await runs.answer(ctx, arg);
						return;
					}
					if (kind === 'flow' && op === 'cancel') {
						ctx.ui.notify(format(cancelRun(ctx, arg)), 'info');
						return;
					}
					if (kind === 'flow' && op === 'status') {
						if (ctx.mode !== 'tui') {
							show(ctx, !arg ? listRuns(ctx) : states.owns(ctx, arg) ? states.inspect(ctx, arg) : runs.inspect(ctx, arg));
							return;
						}
						let id = arg;
						if (!id) {
							const list = listRuns(ctx);
							if (!list.length) {
								ctx.ui.notify('本分支暂无运行', 'info');
								return;
							}
							const labels = list.toReversed().map((x) => `${clean(x.name)} · ${clean(x.phase)} · ${x.id}`);
							const selected = await ctx.ui.select('Flow 运行记录', labels);
							if (!selected) return;
							id = list[list.length - 1 - labels.indexOf(selected)].id;
						}
						if (revision !== epoch) return;
						if (states.owns(ctx, id)) {
							show(ctx, states.inspect(ctx, id));
							return;
						}
						const view = runs.views.openFull(ctx, id);
						try {
							await showRun(ctx, () => {
								if (revision !== epoch) throw new Error('会话或分支已切换');
								return view.frame;
							});
						} finally {
							view.close();
						}
						return;
					}
					const names = listDefs(root, kind);
					if (op === 'list') {
						if (ctx.mode === 'tui' && names.length) {
							const pick = await chooseName(ctx, `查看 ${kind} · ${root}`, names);
							if (pick && revision === epoch) await browse(ctx, root, kind, pick);
						} else if (ctx.mode === 'tui') ctx.ui.notify(`尚无 ${kind} 定义`, 'info');
						else show(ctx, { root, names });
						return;
					}
					if (op === 'view' && arg) {
						await browse(ctx, root, kind, arg);
						return;
					}
					if (!ctx.hasUI) throw new Error(`编辑需要交互界面。模型可用 flow_define；/${kind} list 可列出定义。`);
					if (op === 'json' && arg) {
						await editDefinition(ctx, root, kind, arg, !names.includes(arg), revision, true);
						return;
					}
					if (op === 'new' || op === 'new-graph' || op === 'edit') {
						const name =
							arg ||
							(op !== 'edit'
								? (await ctx.ui.input(`新 ${kind} 名称 · ${clean(root)}`))?.trim()
								: await chooseName(ctx, `编辑 ${kind} · ${root}`, names));
						if (name) await editDefinition(ctx, root, kind, name, op !== 'edit', revision, false, op === 'new-graph');
						return;
					}
					if (op)
						throw new Error(
							`/${kind} [list | view 名称 | new 名称 | new-graph 名称 | edit 名称 | json 名称${kind === 'flow' ? ' | start 名称 | delete [名称] | status [id] | answer id | cancel id' : ''}]`,
						);
					const choices = ['新建…', ...names.map((n, i) => `${i + 1}. 编辑：${clean(n)}`)];
					if (kind === 'flow' && names.length) choices.push('删除 Flow…');
					const pick = await ctx.ui.select(`${kind} · ${clean(root)}`, choices);
					if (!pick || revision !== epoch) return;
					if (pick === '删除 Flow…') {
						await deleteCommand(ctx, root);
						return;
					}
					const create = pick === choices[0];
					const name = create ? (await ctx.ui.input(`新 ${kind} 名称`))?.trim() : names[choices.indexOf(pick) - 1];
					if (name) await editDefinition(ctx, root, kind, name, create, revision);
				} catch (e) {
					ctx.ui.notify(clean(err(e)), 'error');
				}
			},
		});
}
function show(ctx: ExtensionContext, value: unknown) {
	ctx.ui.notify(format(value), 'info');
}
