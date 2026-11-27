import { createHash, randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { checkBag, type Bag, type Compiled } from './contract.ts';
import { startRun, type RunEvent } from './runner.ts';
import { diagramFrom, type Diagram } from './graph-lines.ts';
import { presentation, RUN_ENTRY } from './run-frames.ts';
import type { RunFrame } from './run-board.ts';
import { invokeTemplate } from './template.ts';
import { Caller } from './caller.ts';

type Phase = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
type Summary = {
	id: string;
	name: string;
	version: string;
	phase: Phase;
	pending: string[];
	drained: boolean;
	output?: Bag;
	error?: string;
};
type Journal = { id: string; summary?: Summary; step?: RunEvent; graph?: Diagram };
type Gate = { question: string; inputs?: Bag; answer: (yes: boolean) => void };
type Reply = Summary & { instruction?: string; gates?: { node: string; question: string; inputs?: Bag }[] };
type Live = {
	summary: Summary;
	stop: () => void;
	gates: Map<string, Gate>;
	resume?: (ctx: ExtensionToolContext, s?: AbortSignal) => Promise<Reply>;
};
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Definitions are shared by config root. Runs and their journal belong only to this Pi branch.
export function runBook(pi: ExtensionAPI) {
	const live = new Map<string, Live>();
	const views = presentation();
	const record = (l: Live, data: Journal) => {
		if (live.get(l.summary.id) !== l) return;
		pi.appendEntry(RUN_ENTRY, structuredClone(data));
		views.update(data);
	};
	const stamp = (l: Live) => record(l, { id: l.summary.id, summary: l.summary });
	function reset(ctx?: ExtensionContext) {
		views.reset(ctx);
		const old = [...live.values()];
		live.clear(); // Detach first: cancellation/drain callbacks must not write to another branch.
		for (const l of old) l.stop();
	}
	pi.on('session_start', (_event, ctx) => reset(ctx));
	pi.on('session_tree', (_event, ctx) => reset(ctx));
	pi.on('session_shutdown', () => reset());

	async function launch(
		ctx: ExtensionToolContext,
		graph: Compiled,
		input: unknown,
		signal?: AbortSignal,
		progress?: (f: RunFrame) => void,
	) {
		const start = Object.values(graph.nodes).find((n) => n.kind === 'start')!;
		const supplied =
			input ??
			(Object.keys(start.outputs).length === 1 && start.outputs.out?.type === 'null'
				? { out: { type: 'null', value: null } }
				: {});
		const bag = checkBag(supplied, start.outputs, ctx.cwd);
		signal?.throwIfAborted();
		const id = randomUUID();
		const version = createHash('sha256').update(JSON.stringify(graph)).digest('hex');
		const summary: Summary = { id, name: graph.name, version, phase: 'running', pending: [], drained: false };
		const controller = new AbortController();
		const abort = () => controller.abort();
		const caller = new Caller();
		const usesTools = Object.values(graph.nodes).some((node) => node.tools?.length);
		const l: Live = { summary, stop: abort, gates: new Map() };
		live.set(id, l);
		let wake: (() => void) | undefined;
		const reply = (): Reply => ({
			...structuredClone(summary),
			...(l.gates.size
				? {
						gates: [...l.gates].map(([node, g]) => ({ node, question: g.question, inputs: g.inputs })),
						instruction: `Waiting for the user: /flow answer ${id}. Never restart the flow. After answering, use flow_continue if tool execution is pending.`,
					}
				: {}),
		});
		const refresh = () => {
			summary.pending = [...l.gates.keys()];
			if (summary.phase === 'running' || summary.phase === 'waiting')
				summary.phase = l.gates.size ? 'waiting' : 'running';
			stamp(l);
		};
		const topology = diagramFrom(graph);
		views.open(id, ctx, topology);
		const detach = progress && views.watch(id, 'launch', progress);
		try {
			record(l, { id, summary, graph: topology });
			// Pi's native result region accepts clicks once it has its first partial result.
			if (progress) {
				try {
					progress(views.get(id)!);
				} catch {
					/* UI observers never control execution. */
				}
			}
			const run = startRun(graph, bag, {
				cwd: ctx.cwd,
				signal: controller.signal,
				invoke: (node, inputs, s, nodeId) =>
					node.tools?.length
						? caller.use(s, (current) => invokeTemplate(current, node, inputs, s, nodeId))
						: invokeTemplate(ctx, node, inputs, s, nodeId),
				event: (step) => record(l, { id, step }),
				gate: (node, question, s, inputs?: Bag) =>
					new Promise<boolean>((resolve, reject) => {
						if (s.aborted) {
							reject(new Error('Gate cancelled'));
							return;
						}
						const close = () => {
							s.removeEventListener('abort', cancel);
							l.gates.delete(node);
							refresh();
						};
						const cancel = () => {
							close();
							reject(new Error('Gate cancelled'));
						};
						l.gates.set(node, {
							question,
							inputs,
							answer: (yes) => {
								close();
								resolve(yes);
							},
						});
						s.addEventListener('abort', cancel, { once: true });
						refresh();
						wake?.();
					}),
			});
			const main = run.done
				.then(
					(output) => {
						summary.output = output;
						summary.phase = 'succeeded';
					},
					(error) => {
						summary.error = why(error);
						summary.phase = controller.signal.aborted ? 'cancelled' : 'failed';
					},
				)
				.then(() => stamp(l));
			// done releases downstream consumers without waiting for remaining:finish workers.
			const drain = Promise.allSettled([main, run.drained]).then(() => {
				summary.drained = true;
				stamp(l);
				if (live.get(id) === l) live.delete(id);
			});
			l.resume = async (current, s) => {
				if (l.gates.size) return reply(); // A new tool call cannot approve a gate.
				caller.attach(current);
				s?.addEventListener('abort', abort, { once: true });
				if (s?.aborted) abort();
				try {
					await Promise.race([
						usesTools ? drain : main,
						new Promise<void>((resolve) => {
							wake = resolve;
						}),
					]);
				} finally {
					wake = undefined;
					await caller.detach(); // do not orphan Pi nested-call IDs when releasing at a gate
					s?.removeEventListener('abort', abort);
				}
				return reply();
			};
			return await l.resume(ctx, signal);
		} catch (error) {
			abort();
			summary.phase = 'failed';
			summary.error = why(error);
			summary.drained = true;
			stamp(l);
			live.delete(id);
			throw error;
		} finally {
			detach?.();
		}
	}
	function inspect(ctx: ExtensionContext, id?: string) {
		const runs = new Map<string, Summary>();
		const steps: unknown[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== 'custom' || entry.customType !== RUN_ENTRY) continue;
			const j = entry.data as Journal | undefined;
			if (!j?.id || (id && j.id !== id)) continue;
			if (j.summary) runs.set(j.id, structuredClone(j.summary));
			if (id && j.step) steps.push(j.step);
		}
		for (const [key, l] of live) if (!id || key === id) runs.set(key, structuredClone(l.summary));
		for (const [key, s] of runs)
			if (!live.has(key) && !s.drained) {
				if (s.phase === 'waiting' || s.phase === 'running') s.phase = 'interrupted';
				s.pending = [];
				s.error ??= 'Runtime ended before drain; inspect side effects before rerunning. No automatic replay.';
			}
		if (!id) return [...runs.values()];
		if (!runs.has(id)) throw new Error(`No such run in this session branch: ${id}`);
		return {
			...runs.get(id),
			steps,
			gates: [...(live.get(id)?.gates ?? [])].map(([node, g]) => ({ node, question: g.question, inputs: g.inputs })),
		};
	}
	function cancel(id: string) {
		const l = live.get(id);
		if (!l) throw new Error(`No live run: ${id}`);
		l.stop();
		return { id, cancellationRequested: true };
	}
	// Only reached from a user-issued Pi command and a UI response; not a model tool.
	async function answer(ctx: ExtensionContext, id: string) {
		if (!ctx.hasUI) throw new Error('Answering a gate requires a user dialog.');
		const l = live.get(id);
		if (!l?.gates.size) throw new Error(`No pending gate for ${id}`);
		const keys = [...l.gates.keys()];
		const key = keys.length === 1 ? keys[0] : await ctx.ui.select('选择人工关口', keys);
		if (!key) return;
		const gate = l.gates.get(key);
		if (!gate) return;
		const pick = await ctx.ui.select(
			`${l.summary.name} · ${key}\n${gate.question}${gate.inputs ? `\n${JSON.stringify(gate.inputs).slice(0, 2048)}` : ''}`,
			['批准', '拒绝'],
		);
		if (!pick) return; // Esc leaves the gate pending, never an implicit yes/no.
		if (live.get(id) !== l || l.gates.get(key) !== gate) throw new Error('This gate is no longer pending.');
		gate.answer(pick === '批准');
		ctx.ui.notify(`已记录。如后续步骤使用 Pi 工具，请让模型调用 flow_continue（id: ${id}），不要重新启动。`, 'info');
	}
	async function resume(ctx: ExtensionToolContext, id: string, s?: AbortSignal) {
		const l = live.get(id);
		if (l?.resume) return l.resume(ctx, s);
		return inspect(ctx, id); // Already finished; never rerun side effects.
	}
	return { launch, inspect, cancel, answer, resume, views };
}
