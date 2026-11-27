import { readFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { compile, validateAction, type Action, type Flow } from './contract.ts';
import { globalsFor, listDefs, readDef, rootFor, saveDef } from './store.ts';
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
async function chooseName(ctx: ExtensionCommandContext, title: string, names: string[]): Promise<string | undefined> {
	if (!names.length) return undefined;
	const labels = names.map((n, i) => `${i + 1}. ${clean(n)}`);
	const picked = await ctx.ui.select(clean(title), labels);
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

function starter(kind: Kind, name: string): Action | Flow {
	if (kind === 'action') return { extends: 'builtin:action', template: '将 in 消息原样返回到 out 端口。' };
	return {
		name,
		nodes: { start: { use: 'builtin:start' }, end: { use: 'builtin:end' } },
		edges: [{ from: ['start', 'out'], to: ['end', 'in'] }],
	};
}
function put(root: string, kind: Kind, name: string, value: unknown) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Definition must be a JSON object.');
	const globals = globalsFor(root);
	if (kind === 'flow') {
		if ((value as Flow).name !== name) throw new Error('Flow.name must match the name being saved.');
		compile(value, globals);
	} else validateAction(name, value as Action, { ...globals, [name]: value as Action });
	saveDef(root, kind, name, value);
	return { root, kind, name, saved: true };
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
	let pinnedRoot: string | undefined;
	let epoch = 0;
	// A directory created during a run by another tool does not silently move the editor.
	const storage = (ctx: ExtensionContext) => (pinnedRoot ??= rootFor(ctx));
	pi.on('session_start', () => {
		epoch++;
		pinnedRoot = undefined;
	});
	pi.on('session_tree', () => {
		epoch++;
	});
	pi.on('session_shutdown', () => {
		epoch++;
	});
	const renderRun = presentRun(runs);
	pi.registerTool({
		name: 'flow_guide',
		label: 'Flow: definition guide',
		description:
			'Get the Flow/Action authoring contract, builtin port defaults, typed messages, fork/join policies and a runnable example. Read before authoring a new graph.',
		parameters: Type.Object({}),
		execute: async () => text(extractFlowGuide(readFileSync(new URL('../../README.md', import.meta.url), 'utf8'))),
	});
	pi.registerTool({
		name: 'flow_inspect',
		label: 'Flow: view definitions',
		renderCall: toolHeading('查看定义'),
		renderResult: presentDefinition,
		description:
			'List named flows or global actions in the session config root, or view the complete named definition. Local and anonymous actions are inside their owning flow.',
		parameters: Type.Object({ kind: kindParam, name: Type.Optional(nameParam) }),
		execute: async (_id, { kind, name }, _s, _u, ctx) => {
			const root = storage(ctx);
			return text(
				name === undefined
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
			'Create or replace a named Flow or global Action. Pass the complete JSON definition (see flow_guide). Flow-local actions live in flow.actions; inline node definitions are anonymous. Validation and save do not execute anything.',
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
				p.kind === 'flow' ? { diagram: diagramFrom(p.definition as Flow) } : {},
			),
	});
	pi.registerTool({
		name: 'flow_run',
		label: 'Flow: run',
		renderCall: toolHeading('运行流程'),
		renderResult: renderRun,
		exposure: 'model-only',
		description:
			'Run a named flow with a fixed snapshot of its actions. Input keys are START OUTPUT port names, values are typed {type,value} messages. Returns the end result or a pending human gate; do not restart a waiting run. Use flow_status for progress and late results.',
		parameters: Type.Object({
			name: nameParam,
			input: Type.Optional(
				Type.Object(
					{},
					{ additionalProperties: true, description: 'Initial port messages. Omit for default null start.' },
				),
			),
		}),
		execute: async (_id, p, s, update, ctx) => {
			const root = storage(ctx);
			const graph = compile(readDef(root, 'flow', p.name), globalsFor(root));
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
		name: 'flow_continue',
		label: 'Flow: continue',
		renderCall: toolHeading('继续流程'),
		renderResult: renderRun,
		exposure: 'model-only',
		description:
			'After a human has answered a gate, reattach this Pi tool call to the existing run so subsequent tool-enabled actions can use a live caller. Does not approve a gate, restart a run or replay actions.',
		parameters: Type.Object({ id: Type.String() }),
		execute: async (callId, p, s, update, ctx) => {
			const tick =
				ctx.mode === 'tui' && update
					? (frame: RunFrame) => update(toolText(`${frame.name} · ${frame.phase}`, { frame }))
					: undefined;
			const unsubscribe = tick && runs.views.watch(p.id, `continue:${callId}`, tick);
			try {
				const start = tick && runs.views.get(p.id);
				if (start && tick) tick(start);
				return toolText(await runs.resume(ctx, p.id, s), { frame: runs.views.get(p.id) });
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
			'View run summaries in this session branch, or one run’s steps, pending human gates, final result and late worker records.',
		parameters: Type.Object({ id: Type.Optional(Type.String()) }),
		execute: async (_id, p, _s, _u, ctx) =>
			toolText(runs.inspect(ctx, p.id), p.id ? { frame: runs.views.get(p.id, false, ctx) } : {}),
	});
	pi.registerTool({
		name: 'flow_cancel',
		label: 'Flow: cancel run',
		description:
			'Request cancellation of an active run including unfinished workers. Does not undo completed side effects.',
		parameters: Type.Object({ id: Type.String() }),
		execute: async (_id, p) => text(runs.cancel(p.id)),
	});

	async function browse(ctx: ExtensionCommandContext, root: string, kind: Kind, name: string) {
		const v = readDef(root, kind, name);
		if (ctx.mode !== 'tui') {
			show(ctx, { root, definition: v });
			return;
		}
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
	) {
		if (revision !== epoch) throw new Error('会话或分支已切换，请重新打开。');
		const original = create ? undefined : readDef(root, kind, name);
		if (create && listDefs(root, kind).includes(name)) throw new Error(`Already exists: ${name}`);
		const save = (v: unknown) => {
			if (epoch !== revision) throw new Error('会话或分支已切换，未保存。');
			const current = listDefs(root, kind).includes(name) ? readDef(root, kind, name) : undefined;
			if (JSON.stringify(current) !== JSON.stringify(original))
				throw new Error('定义在编辑期间已被更改，未覆盖。请重新打开。');
			put(root, kind, name, v);
		};
		let draft = structuredClone(original ?? starter(kind, name));
		if (raw || ctx.mode !== 'tui') return jsonEditor(ctx, root, kind, name, draft, save);
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
					? '编辑命名流程 / 查看运行；/flow answer <id> 回答人工关口。'
					: '查看、新建或编辑全局 Action；Flow 专有 Action 在 /flow 内编辑。',
			handler: async (args, ctx) => {
				try {
					const root = storage(ctx),
						revision = epoch;
					const [, op = '', arg = ''] = /^(\S+)?(?:\s+([\s\S]*))?$/.exec(args.trim())!;
					if (kind === 'flow' && op === 'answer') {
						await runs.answer(ctx, arg);
						return;
					}
					if (kind === 'flow' && op === 'cancel') {
						ctx.ui.notify(format(runs.cancel(arg)), 'info');
						return;
					}
					if (kind === 'flow' && op === 'status') {
						if (ctx.mode !== 'tui') {
							show(ctx, runs.inspect(ctx, arg || undefined));
							return;
						}
						let id = arg;
						if (!id) {
							const list = runs.inspect(ctx) as { id: string; name: string; phase: string }[];
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
					if (op === 'new' || op === 'edit') {
						const name =
							arg ||
							(op === 'new'
								? (await ctx.ui.input(`新 ${kind} 名称 · ${clean(root)}`))?.trim()
								: await chooseName(ctx, `编辑 ${kind} · ${root}`, names));
						if (name) await editDefinition(ctx, root, kind, name, op === 'new', revision);
						return;
					}
					if (op)
						throw new Error(
							`/${kind} [list | view 名称 | new 名称 | edit 名称 | json 名称${kind === 'flow' ? ' | status [id] | answer id | cancel id' : ''}]`,
						);
					const choices = ['新建…', ...names.map((n, i) => `${i + 1}. 编辑：${clean(n)}`)];
					const pick = await ctx.ui.select(`${kind} · ${clean(root)}`, choices);
					if (!pick || revision !== epoch) return;
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
