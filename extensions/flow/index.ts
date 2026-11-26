import { readFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { compile, validateAction, type Action, type Flow } from './contract.ts';
import { globalsFor, listDefs, readDef, rootFor, saveDef } from './store.ts';
import { runBook } from './runs.ts';

type Kind = 'action' | 'flow';
const kindParam = Type.Union([Type.Literal('flow'), Type.Literal('action')]);
const nameParam = Type.String({ description: 'Exact definition name in this config root.' });
const format = (value: unknown) => JSON.stringify(value, null, 2);
const text = (value: unknown) => ({
	content: [{ type: 'text' as const, text: typeof value === 'string' ? value : format(value) }],
	details: {},
});
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));
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

/** One editor for both namespaces. Bad JSON/invalid graphs keep the draft instead of discarding edits. */
async function editor(ctx: ExtensionCommandContext, root: string, kind: Kind, name: string, creating: boolean) {
	const original = creating ? undefined : readDef(root, kind, name);
	if (creating && listDefs(root, kind).includes(name)) throw new Error(`Already exists: ${name}`);
	let draft = format(original ?? starter(kind, name));
	for (;;) {
		const next = await ctx.ui.editor(`编辑 ${kind} · ${name} · ${root}`, draft);
		if (next === undefined) return;
		draft = next;
		// Catch a common lost-update case (another session saved while the editor was open).
		const current = listDefs(root, kind).includes(name) ? readDef(root, kind, name) : undefined;
		if (JSON.stringify(current) !== JSON.stringify(original))
			throw new Error('定义在编辑期间已被更改，未覆盖。请重新打开。');
		try {
			put(root, kind, name, JSON.parse(draft));
		} catch (e) {
			ctx.ui.notify(err(e), 'error');
			continue;
		}
		ctx.ui.notify(`已保存 ${name} · ${root}`, 'info');
		return;
	}
}

export default function flowExtension(pi: ExtensionAPI) {
	const runs = runBook(pi);
	let pinnedRoot: string | undefined;
	// A directory created during a run by another tool does not silently move the editor.
	const storage = (ctx: ExtensionContext) => (pinnedRoot ??= rootFor(ctx));
	pi.on('session_start', () => {
		pinnedRoot = undefined;
	});
	pi.registerTool({
		name: 'flow_guide',
		label: 'Flow: definition guide',
		description:
			'Get the Flow/Action authoring contract, builtin port defaults, typed messages, fork/join policies and a runnable example. Read before authoring a new graph.',
		parameters: Type.Object({}),
		execute: async () => text(readFileSync(new URL('./GUIDE.md', import.meta.url), 'utf8')),
	});
	pi.registerTool({
		name: 'flow_inspect',
		label: 'Flow: view definitions',
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
		execute: async (_id, p, _s, _u, ctx) => text(put(storage(ctx), p.kind, p.name, p.definition)),
	});
	pi.registerTool({
		name: 'flow_run',
		label: 'Flow: run',
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
		execute: async (_id, p, s, _u, ctx) => {
			const root = storage(ctx);
			const graph = compile(readDef(root, 'flow', p.name), globalsFor(root));
			const result = await runs.launch(ctx, graph, p.input, s);
			if (result.phase === 'failed' || result.phase === 'cancelled') throw new Error(format(result));
			return text(result);
		},
	});
	pi.registerTool({
		name: 'flow_continue',
		label: 'Flow: continue',
		exposure: 'model-only',
		description:
			'After a human has answered a gate, reattach this Pi tool call to the existing run so subsequent tool-enabled actions can use a live caller. Does not approve a gate, restart a run or replay actions.',
		parameters: Type.Object({ id: Type.String() }),
		execute: async (_id, p, s, _u, ctx) => text(await runs.resume(ctx, p.id, s)),
	});
	pi.registerTool({
		name: 'flow_status',
		label: 'Flow: run status',
		description:
			'View run summaries in this session branch, or one run’s steps, pending human gates, final result and late worker records.',
		parameters: Type.Object({ id: Type.Optional(Type.String()) }),
		execute: async (_id, p, _s, _u, ctx) => text(runs.inspect(ctx, p.id)),
	});
	pi.registerTool({
		name: 'flow_cancel',
		label: 'Flow: cancel run',
		description:
			'Request cancellation of an active run including unfinished workers. Does not undo completed side effects.',
		parameters: Type.Object({ id: Type.String() }),
		execute: async (_id, p) => text(runs.cancel(p.id)),
	});

	for (const kind of ['flow', 'action'] as const)
		pi.registerCommand(kind, {
			description:
				kind === 'flow'
					? '编辑命名流程 / 查看运行；/flow answer <id> 回答人工关口。'
					: '查看、新建或编辑全局 Action；Flow 专有 Action 在 /flow 内编辑。',
			handler: async (args, ctx) => {
				try {
					const root = storage(ctx);
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
						show(ctx, runs.inspect(ctx, arg || undefined));
						return;
					}
					const names = listDefs(root, kind);
					if (op === 'list') {
						show(ctx, { root, names });
						return;
					}
					if (op === 'view' && arg) {
						show(ctx, { root, definition: readDef(root, kind, arg) });
						return;
					}
					if (!ctx.hasUI) throw new Error(`编辑需要交互界面。模型可用 flow_define；/${kind} list 可列出定义。`);
					if (op === 'new' || op === 'edit') {
						const name =
							arg ||
							(op === 'new'
								? (await ctx.ui.input(`新 ${kind} 名称 · ${root}`))?.trim()
								: await ctx.ui.select(`编辑 ${kind} · ${root}`, names));
						if (name) await editor(ctx, root, kind, name, op === 'new');
						return;
					}
					if (op)
						throw new Error(
							`/${kind} [list | view 名称 | new 名称 | edit 名称${kind === 'flow' ? ' | status [id] | answer id | cancel id' : ''}]`,
						);
					const pick = await ctx.ui.select(`${kind} · ${root}`, ['新建…', ...names.map((n) => `编辑：${n}`)]);
					if (!pick) return;
					const create = pick === '新建…';
					const name = create ? (await ctx.ui.input(`新 ${kind} 名称`))?.trim() : pick.slice('编辑：'.length);
					if (name) await editor(ctx, root, kind, name, create);
				} catch (e) {
					ctx.ui.notify(err(e), 'error');
				}
			},
		});
}
function show(ctx: ExtensionContext, value: unknown) {
	ctx.ui.notify(format(value), 'info');
}
