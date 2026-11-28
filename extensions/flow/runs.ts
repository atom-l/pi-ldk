import { createHash, randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { checkBag, type Bag, type Compiled } from './contract.ts';
import { startRun, type GateAnswer, type RunEvent } from './runner.ts';
import { diagramFrom, type Diagram } from './graph-lines.ts';
import { presentation, RUN_ENTRY } from './run-frames.ts';
import type { RunFrame, RunRequest } from './run-board.ts';
import { invokeTemplate } from './template.ts';
import { Caller } from './caller.ts';
import { FlowKnowledge } from './knowledge.ts';
import { FlowHumanUI } from './human.ts';
import { FlowHostRelay } from './host-relay.ts';

type Phase = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
type Summary = {
	id: string;
	name: string;
	version: string;
	phase: Phase;
	pending: string[];
	requests?: RunRequest[];
	drained: boolean;
	output?: Bag;
	error?: string;
};
type Journal = { id: string; summary?: Summary; step?: RunEvent; graph?: Diagram };
type Gate = { question: string; inputs?: Bag; signal: AbortSignal; answer: (yes: boolean, handBack?: boolean) => void };
type Handoff = { node: string; question: string; inputs?: Bag };
type Held = { request: Handoff; release: () => void };
type Reply = Summary & { instruction?: string; gates?: { node: string; question: string; inputs?: Bag }[] };
type Live = {
	summary: Summary;
	relay?: FlowHostRelay;
	stop: () => void;
	gates: Map<string, Gate>;
	held: Map<string, Held>;
	resume?: (ctx: ExtensionToolContext, s?: AbortSignal) => Promise<Reply>;
};
function handoffDetails(l?: Live) {
	if (!l?.held.size) return {};
	const requests = Array.from(l.held.values(), (h) => structuredClone(h.request));
	return { handoff: requests[0], ...(requests.length > 1 ? { handoffs: requests } : {}) };
}
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Definitions are shared by config root. Runs and their journal belong only to this Pi branch.
export function runBook(pi: ExtensionAPI) {
	const live = new Map<string, Live>();
	const views = presentation();
	const human = new FlowHumanUI();
	let hidden = new Set<string>();
	// Only declaration names: never import the outer prompt or messages into an Action.
	pi.on('before_agent_start', (e) => {
		hidden = new Set(e.systemPromptOptions.hiddenTools);
	});
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
		hidden.clear();
		for (const l of old) {
			l.stop();
			l.relay?.close();
		}
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
		const knowledge = new FlowKnowledge((reader, source, version) =>
			record(l, { id, step: { type: 'context_read', id: reader, source, version } }),
		);
		const usesTools = Object.values(graph.nodes).some((node) => node.tools?.length);
		const l: Live = { summary, stop: abort, gates: new Map(), held: new Map() };
		live.set(id, l);
		let wake: (() => void) | undefined;
		const forms = new Map<string, string>();
		const relay = new FlowHostRelay(
			pi,
			ctx,
			id,
			() => {
				if (live.get(id) !== l) return;
				refresh();
				if (relay.requests().length) wake?.();
			},
			(name) => !hidden.has(name),
		);
		l.relay = relay;
		const reply = () => ({
			...structuredClone(summary),
			...(!summary.drained && summary.output
				? {
						instruction:
							'The main path finished. A late Action may still need tools: call flow_continue with this id to finish pending work. Never restart.',
					}
				: {}),
			...(l.held.size
				? {
						...handoffDetails(l),
						instruction:
							'The user approved and handed this stage back to the initiating session. Perform the agreed work, then flow_continue the same id. Do not restart.',
					}
				: {}),
			...(relay.requests().length
				? {
						hostRequests: relay.requests(),
						hostInstruction:
							'Only the initiating model can issue these model-only tools. If appropriate, call the exact tool with the shown arguments as a top-level call, then flow_continue with this id and requestId. Do not repeat side effects to find a result. Never supply invented tool output.',
					}
				: {}),
			...(l.gates.size
				? {
						gates: [...l.gates].map(([node, g]) => ({ node, question: g.question, inputs: g.inputs })),
						instruction: `Waiting for the user: /flow answer ${id}. Never restart the flow. After answering, use flow_continue if tool execution is pending.`,
					}
				: {}),
		});
		const refresh = () => {
			summary.pending = [...l.gates.keys()];
			const requests: NonNullable<Summary['requests']> = [
				...[...l.gates].map(([node, g]) => ({
					node,
					question: g.question.slice(0, 240),
					kind: 'approval' as const,
				})),
				...[...l.held.keys()].map((node) => ({ node, question: '已批准；待主会话实施后继续', kind: 'handoff' as const })),
				...[...forms].map(([node, question]) => ({ node, question, kind: 'question' as const })),
				...relay.requests().map((r) => ({ node: r.node, question: r.tool, kind: 'host' as const })),
			];
			if (requests.length) summary.requests = requests;
			else delete summary.requests;
			if (summary.phase === 'running' || summary.phase === 'waiting')
				summary.phase = requests.length ? 'waiting' : 'running';
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
				inputs: (nodeId, inputs) => knowledge.begin(nodeId, inputs),
				invoke: async (node, inputs, s, nodeId) => {
					if (!node.template) return invokeTemplate(ctx, node, inputs, s, nodeId);
					const base = node.tools?.length ? await caller.use(s, async (current) => current) : (caller.attached ?? ctx);
					const localTools = knowledge.localTools(nodeId);
					if (base.mode === 'tui' && base.hasUI && typeof base.ui.custom === 'function') {
						const ask = human.askTool(base, { runId: id, flow: graph.name, node: nodeId });
						localTools.push({
							...ask,
							execute: (args, signal) =>
								caller.use(signal, async () => {
									forms.set(nodeId, '等待用户填写回复表单');
									refresh();
									try {
										return await ask.execute(args, signal);
									} finally {
										forms.delete(nodeId);
										refresh();
									}
								}),
						});
					}
					return invokeTemplate(base, node, inputs, s, nodeId, {
						withHost: (signal, fn) => caller.use(signal, fn),
						localTools,
						getLocalTools: () => [...localTools, ...relay.localTools(nodeId)],
						hostToolVisible: (name) => !hidden.has(name),
						onTool: (step) => {
							knowledge.observe(step);
							record(l, { id, step });
						},
					});
				},
				event: (step) => {
					knowledge.observe(step);
					record(l, { id, step });
				},
				gate: (node, question, s, inputs?: Bag) =>
					new Promise<GateAnswer>((resolve, reject) => {
						if (s.aborted) {
							reject(new Error('Gate cancelled'));
							return;
						}
						const dialog = new AbortController();
						const close = () => {
							dialog.abort();
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
							signal: dialog.signal,
							answer: (yes, handBack) => {
								let decision: GateAnswer = yes;
								if (yes && handBack) {
									const waitForContinue = new Promise<void>((done) => {
										const release = () => {
											s.removeEventListener('abort', release);
											l.held.delete(node);
											if (s.aborted) refresh();
											done();
										};
										l.held.set(node, { request: { node, question, inputs }, release });
										s.addEventListener('abort', release, { once: true });
									});
									decision = { approved: true, waitForContinue };
									wake?.();
								}
								close();
								resolve(decision);
							},
						});
						s.addEventListener('abort', cancel, { once: true });
						refresh();
						if (ctx.mode !== 'tui' || !ctx.hasUI || typeof ctx.ui.custom !== 'function') {
							wake?.();
							return;
						}
						const gate = l.gates.get(node)!;
						void human.gate(ctx, { runId: id, flow: graph.name, node, question, inputs }, dialog.signal).then(
							(choice) => {
								if (live.get(id) !== l || l.gates.get(node) !== gate) return;
								if (choice === undefined)
									wake?.(); // Esc: release caller for discussion; still pending.
								else if (choice === 'handoff') gate.answer(true, true);
								else gate.answer(choice);
							},
							() => {
								if (l.gates.get(node) === gate) wake?.();
							},
						);
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
				relay.close();
			});
			l.resume = async (current, s) => {
				if (l.gates.size || relay.requests().length) return reply(); // A new tool call cannot approve a gate.
				caller.attach(current);
				if (l.held.size) {
					for (const h of l.held.values()) h.release();
					refresh();
				}
				s?.addEventListener('abort', abort, { once: true });
				if (s?.aborted) abort();
				try {
					await Promise.race([
						usesTools || summary.output || summary.phase === 'failed' || summary.phase === 'cancelled'
							? drain
							: main,
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
			relay.close();
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
				delete s.requests;
				s.error ??= 'Runtime ended before drain; inspect side effects before rerunning. No automatic replay.';
			}
		if (!id) return [...runs.values()];
		if (!runs.has(id)) throw new Error(`No such run in this session branch: ${id}`);
		return {
			...runs.get(id),
			steps,
			...handoffDetails(live.get(id)),
			...(live.get(id)?.relay?.requests().length ? { hostRequests: live.get(id)!.relay!.requests() } : {}),
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
		let choice: boolean | 'handoff' | undefined;
		if (ctx.mode === 'tui' && typeof ctx.ui.custom === 'function') {
			choice = await human.gate(
				ctx,
				{ runId: id, flow: l.summary.name, node: key, question: gate.question, inputs: gate.inputs },
				gate.signal,
			);
		} else {
			const pick = await ctx.ui.select(
				`${l.summary.name} · ${key}\n${gate.question}${gate.inputs ? `\n${JSON.stringify(gate.inputs).slice(0, 2048)}` : ''}`,
				['批准', '拒绝'],
			);
			choice = pick === '批准' ? true : pick === '拒绝' ? false : undefined;
		}
		if (choice === undefined) return;
		if (live.get(id) !== l || l.gates.get(key) !== gate) throw new Error('This gate is no longer pending.');
		gate.answer(choice !== false, choice === 'handoff');
		ctx.ui.notify(`已记录。如后续步骤使用 Pi 工具，请让模型调用 flow_continue（id: ${id}），不要重新启动。`, 'info');
	}
	async function resume(ctx: ExtensionToolContext, id: string, s?: AbortSignal, requestId?: string, toolCallId?: string) {
		const l = live.get(id);
		if (requestId) {
			if (!l?.relay) throw new Error('No live host tool request in this run.');
			if (!l.relay.accept(ctx, requestId, toolCallId))
				throw new Error(
					'No unambiguous matching host result. Check the actual tool call ID; do not repeat a side effect.',
				);
		}
		if (l?.resume) return l.resume(ctx, s);
		return inspect(ctx, id); // Already finished; never rerun side effects.
	}
	return { launch, inspect, cancel, answer, resume, views };
}
