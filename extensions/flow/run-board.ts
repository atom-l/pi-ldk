import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import type { Bag } from './contract.ts';
import { clean, diagramLines, type Diagram } from './graph-lines.ts';
import type { RunEvent } from './runner.ts';
import type { FlowToolEvent } from './runtime-types.ts';

/** Display snapshot, never the execution protocol. A tail need not include node_start. */
export type RunRequest = { node: string; question: string; kind: 'approval' | 'question' | 'host' | 'handoff' };
export type RunFrame = {
	id: string;
	name: string;
	phase: string;
	drained: boolean;
	pending: string[];
	requests?: RunRequest[];
	graph?: Diagram;
	steps: RunEvent[];
	error?: string;
	output?: Bag;
	omitted?: number;
	historical?: boolean;
	// Latest calls evicted from the bounded card tail (full viewer replays the journal).
	earlierTools?: FlowToolEvent[];
	// Last known state of nodes whose earlier events no longer fit the card's tail.
	earlier?: Record<string, { kind: string; state: string; route?: string }>;
};

type NodeView = {
	id: string;
	kind: string;
	state: string;
	outputs?: Bag;
	error?: string;
	route?: string;
	gate?: Extract<RunEvent, { type: 'gate' }>;
	join?: Extract<RunEvent, { type: 'join_close' }>;
};
type WorkerView = {
	forkId: string;
	input: string;
	first?: string;
	state: string;
	late?: boolean;
	outputs?: Bag;
	error?: string;
};

function project(f: RunFrame) {
	const nodes = new Map<string, NodeView>(),
		workers = new Map<string, WorkerView>(),
		calls = new Map<string, FlowToolEvent>();
	const node = (id: string, kind?: string) => {
		const n = nodes.get(id) ?? { id, kind: kind ?? '?', state: '—' };
		if (kind) n.kind = kind;
		nodes.set(id, n);
		return n;
	};
	for (const n of f.graph?.nodes ?? []) node(n.id, n.kind);
	for (const [id, info] of Object.entries(f.earlier ?? {})) Object.assign(node(id, info.kind), info);
	function observeCall(e: FlowToolEvent) {
		// Call IDs are scoped to an Action conversation, not to a Flow.
		const key = JSON.stringify([e.id, e.callId]);
		calls.delete(key);
		calls.set(key, e);
		node(e.id);
	}
	for (const e of f.earlierTools ?? []) observeCall(e);
	let phase = f.phase,
		error = f.error,
		output = f.output;
	for (const e of f.steps) {
		if (!e || typeof e !== 'object') continue;
		switch (e.type) {
			case 'action_tool_start':
			case 'action_tool_finish':
				observeCall(e);
				break;
			case 'node_start':
				node(e.id, e.kind).state = 'started';
				break;
			case 'node_cancelled':
				node(e.id, e.kind).state = 'cancelled';
				break;
			case 'node_pruned':
				node(e.id, e.kind).state = 'pruned';
				break;
			case 'node_finish': {
				const n = node(e.id, e.kind);
				n.state = 'done';
				n.outputs = e.outputs;
				if (['decision', 'gate'].includes(e.kind)) n.route = Object.keys(e.outputs ?? {}).join(', ');
				break;
			}
			case 'node_failed':
				Object.assign(node(e.id, e.kind), { state: 'failed', error: e.error });
				break;
			case 'gate':
				Object.assign(node(e.id, 'gate'), { state: 'answered', gate: e, route: e.answer ? 'yes' : 'no' });
				break;
			case 'join_close':
				Object.assign(node(e.id, 'join'), { state: 'closed', join: e });
				break;
			case 'worker_start':
			case 'worker_finish':
			case 'worker_failed':
			case 'worker_cancelled': {
				node(e.forkId, 'fork');
				const key = JSON.stringify([e.forkId, e.input]);
				const w: WorkerView = workers.get(key) ?? { forkId: e.forkId, input: e.input, state: 'started' };
				if (e.type === 'worker_start') w.first = e.id;
				else {
					w.late = e.late;
					if (e.type === 'worker_finish') {
						w.state = 'done';
						w.outputs = e.outputs;
					} else if (e.type === 'worker_failed') {
						w.state = 'failed';
						w.error = e.error;
					} else w.state = 'cancelled';
				}
				// Keep most recently updated workers last, even when their start was long ago.
				workers.delete(key);
				workers.set(key, w);
				break;
			}
			case 'run_finish':
				phase = 'succeeded';
				output ??= e.outputs;
				break;
			case 'run_failed':
				phase = 'failed';
				error ??= e.error;
				break;
			case 'run_cancelled':
				phase = 'cancelled';
				break;
		}
	}
	// A persisted terminal/interrupted summary takes precedence over a partial event tail.
	if (!['running', 'waiting'].includes(f.phase)) phase = f.phase;
	// A succeeded-but-undrained run can still have a request in a late worker.
	const live = !f.drained && !f.historical && ['running', 'waiting', 'succeeded'].includes(phase);
	const requests = live ? [...(f.requests ?? [])] : [];
	const gates = live ? f.pending : [];
	const approvals = new Set(requests.filter((r) => r.kind === 'approval').map((r) => r.node));
	for (const id of gates) {
		node(id, 'gate');
		if (!approvals.has(id)) requests.push({ kind: 'approval', node: id, question: '' }); // legacy journal
	}
	for (const r of requests) node(r.node).state = 'waiting';
	// Older journals do not have node_cancelled. Never infer cancellation from run_finish.
	if (f.drained || f.historical || phase === 'interrupted') {
		for (const n of nodes.values()) if (n.state === 'started') n.state = 'no finish';
		for (const w of workers.values()) if (w.state === 'started') w.state = 'no finish';
	}
	return {
		nodes,
		requests,
		gates,
		workers: [...workers.values()],
		calls: [...calls.values()],
		phase,
		error,
		output,
		badges: new Map([...nodes.values()].map((n) => [n.id, n.route ? `${n.state} → ${clean(n.route)}` : n.state])),
	};
}
type Board = ReturnType<typeof project>;
const fit = (s: string, width: number) => truncateToWidth(s, width, '…');
const paint = (theme: Theme, phase: string) =>
	theme.fg(
		phase === 'succeeded' ? 'success' : phase === 'failed' ? 'error' : phase === 'running' ? 'accent' : 'warning',
		clean(phase),
	);
const section = (theme: Theme, title: string) => theme.fg('accent', title);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Display a bounded preview, including when status() supplies the original journal's large values.
function valueText(value: unknown): string {
	if (typeof value === 'string') return clean(clip(value, 1024));
	let budget = 48;
	function sample(v: unknown, depth: number): unknown {
		if (--budget < 0 || depth > 5) return '…';
		if (typeof v === 'string') return clip(v, 256);
		if (!v || typeof v !== 'object') return v;
		if (Array.isArray(v)) return [...v.slice(0, 8).map((x) => sample(x, depth + 1)), ...(v.length > 8 ? ['…'] : [])];
		const out: Record<string, unknown> = Object.create(null);
		let count = 0;
		for (const k in v)
			if (Object.hasOwn(v, k)) {
				if (++count > 8 || budget <= 0) {
					out['…'] = '…';
					break;
				}
				out[clip(k, 96)] = sample((v as Record<string, unknown>)[k], depth + 1);
			}
		return out;
	}
	return clean(clip(JSON.stringify(sample(value, 0)) ?? '—', 1024));
}
const portText = (port: string, m: Bag[string]) => `${clean(port)} : ${clean(m?.type ?? '?')} = ${valueText(m?.value)}`;
function ports(bag: Bag, max = Infinity): string[] {
	const entries = Object.entries(bag);
	return entries.length
		? [
				...entries.slice(0, max).map(([k, v]) => portText(k, v)),
				...(entries.length > max ? [`… +${entries.length - max} ports`] : []),
			]
		: ['(no ports)'];
}
// In the full viewer each port gets its own field-tree budget: one large value
// cannot hide other ports. Truncation is presentation-only, never journal data.
function portTree(port: string, msg: Bag[string], prefix = ''): string[] {
	const lines: string[] = [];
	let budget = 96;
	const text = (s: string, n: number) => clean(s.slice(0, n)) + (s.length > n ? '…（文本已截断）' : '');
	function visit(label: string, value: unknown, depth: number) {
		const indent = prefix + '  '.repeat(depth);
		budget--;
		if (value === null || typeof value !== 'object') {
			lines.push(
				`${indent}${label} = ${typeof value === 'string' ? text(value, 2048) || '""' : clean(String(value))}`,
			);
			return;
		}
		const arr = Array.isArray(value),
			keys = arr ? [] : Object.keys(value),
			count = arr ? value.length : keys.length;
		lines.push(`${indent}${label} · ${arr ? `数组 [${count}]` : `对象 {${count}}`}`);
		if (!count) return;
		const more = (n: number, why: string) => lines.push(`${indent}  … 省略 ${n} 项（${why}）`);
		if (depth >= 6) {
			more(count, '深度上限');
			return;
		}
		for (let i = 0; i < count; i++) {
			if (i >= 32 || !budget) {
				more(count - i, !budget ? '字段树上限' : '每层上限');
				break;
			}
			if (arr) visit(`[${i}]`, value[i], depth + 1);
			else visit(text(keys[i], 120) || '""', (value as Record<string, unknown>)[keys[i]], depth + 1);
		}
	}
	visit(`${clean(port)} : ${clean(msg?.type ?? '?')}`, msg?.value, 0);
	return lines;
}
function portTrees(bag: Bag): string[] {
	const entries = Object.entries(bag);
	return entries.length ? entries.flatMap(([k, m]) => portTree(k, m)) : ['(no ports)'];
}
function workerTitle(w: WorkerView) {
	return `${w.late ? 'late · ' : ''}${w.state}  ${clean(w.forkId)} / ${clean(w.input)}`;
}
// Action-level evidence, distinct from Pi's bounded native nestedCalls audit.
function callTitle(e: FlowToolEvent, terminal = false) {
	const state = e.type === 'action_tool_start' ? (terminal ? '未见结束' : '调用中') : e.isError ? '失败' : '完成';
	return `${clean(e.id)} · ${clean(e.tool)} · ${state} · #${clean(e.callId)}`;
}
const auditNote = '此处不记录参数或工具返回值。Pi 的嵌套调用审计有数量和大小上限；交由主会话执行的工具可另有原生工具行。';
function eventTitle(e: RunEvent | undefined): string {
	if (!e) return '尚无事件';
	switch (e.type) {
		case 'context_read':
			return `${clean(e.id)} · 查阅 ${clean(e.source)} · #${clean(e.version).slice(0, 16)}`;
		case 'action_tool_start':
		case 'action_tool_finish':
			return `${clean(e.id)} · ${clean(e.tool)} · ${e.type === 'action_tool_start' ? '开始' : e.isError ? '失败' : '完成'} · #${clean(e.callId)}`;
		case 'node_start':
		case 'node_pruned':
		case 'node_cancelled':
		case 'node_failed':
		case 'node_finish':
			return `${clean(e.id)} · ${e.type.slice(5)}${e.type === 'node_finish' && ['gate', 'decision'].includes(e.kind) ? ` → ${clean(Object.keys(e.outputs ?? {}).join(', '))}` : ''}${e.type === 'node_failed' ? `: ${clean(e.error)}` : ''}`;
		case 'gate':
			return `${clean(e.id)} → ${e.answer ? 'yes' : 'no'}`;
		case 'join_close':
			return `${clean(e.id)} · join closed`;
		case 'worker_start':
		case 'worker_finish':
		case 'worker_failed':
		case 'worker_cancelled':
			return `${'late' in e && e.late ? 'late ' : ''}${e.type} · ${clean(e.forkId)} / ${clean(e.input)}`;
		case 'run_failed':
			return `run_failed: ${clean(e.error)}`;
		default:
			return clean(e.type);
	}
}
function title(f: RunFrame, b: Board, t: Theme) {
	return `${paint(t, b.phase)}  ${section(t, clean(f.name))}`;
}
function progress(f: RunFrame, b: Board) {
	const seen = [...b.nodes.values()].filter((n) => n.state !== '—').length;
	const drain = f.drained ? 'drained' : ['running', 'waiting'].includes(b.phase) ? 'live' : 'not drained';
	return `${seen}/${f.graph ? b.nodes.size : '?'} 节点有记录 · ${f.steps.length} 事件${f.omitted ? ` (+${f.omitted} omitted)` : ''} · ${drain}`;
}
function topology(f: RunFrame, b: Board, w: number, t: Theme, max?: number, selected?: string) {
	if (f.graph) return diagramLines(f.graph, w, t, { badges: b.badges, limit: max, selected });
	const observed = [...b.nodes.values()];
	const n = max ?? observed.length;
	return [
		t.fg('dim', '无拓扑快照 · 仅列日志节点'),
		...observed.slice(0, n).map((v) => `${clean(v.id)} [${clean(v.kind)}] ${b.badges.get(v.id)}`),
		...(observed.length > n ? [`… +${observed.length - n} nodes`] : []),
	];
}
function requestText(r: RunRequest) {
	const label = { host: '等待主会话工具', handoff: '已交回主会话', question: '待答问题', approval: '待答 gate' }[r.kind];
	return `${label} · ${clean(r.node)}${r.question ? `：${clean(r.question)}` : ''}`;
}
function resultInfo(f: RunFrame, b: Board, t: Theme, max: number) {
	const lines: string[] = [];
	if (b.error) lines.push(t.fg('error', `! ${clean(b.error)}`));
	for (const r of b.requests.slice(0, max)) lines.push(t.fg('warning', requestText(r)));
	if (b.requests.length > max) lines.push(t.fg('dim', `… 另有 ${b.requests.length - max} 个待处理请求`));
	if (b.gates.length) lines.push(`/flow answer ${clean(f.id)}`);
	if (b.output) lines.push(section(t, '运行结果'), ...(max === Infinity ? portTrees(b.output) : ports(b.output, max)));
	return lines;
}
function combine(left: string[], right: string[], leftWidth: number, t: Theme) {
	return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => {
		const l = fit(left[i] ?? '', leftWidth);
		return `${l}${' '.repeat(Math.max(0, leftWidth - visibleWidth(l)))}${t.fg('borderMuted', ' │ ')}${right[i] ?? ''}`;
	});
}

/** Pi owns the result mouse region and passes its current expanded flag. */
export function runCard(frame: RunFrame, expanded: boolean, theme: Theme): Component {
	const b = project(frame);
	let cached: string[] | undefined,
		lastWidth = -1;
	return {
		invalidate() {
			cached = undefined;
		},
		render(width) {
			if (cached && width === lastWidth) return cached;
			lastWidth = width;
			const status = `/flow status ${clean(frame.id)}`;
			const split = width >= 78;
			const result = resultInfo(frame, b, theme, expanded && split ? 3 : 1);
			const lines = [title(frame, b, theme)];
			if (!expanded) {
				// Internal progress belongs in the details, never in the folded row.
				if (!frame.drained && b.phase === 'succeeded') lines.push(theme.fg('dim', '结果已就绪 · not drained'));
				lines.push(...result);
				lines.push(theme.fg('dim', `▸ 展开详情 · ${status}`));
			} else {
				lines.push(theme.fg('dim', progress(frame, b)));
				const lw = split ? Math.floor((width - 3) * 0.54) : width;
				const recent = frame.steps.findLast((e) => 'id' in e);
				const selected = b.requests[0]?.node ?? (recent && 'id' in recent ? recent.id : undefined);
				const left = [
					section(theme, '拓扑 / 节点'),
					...topology(frame, b, Math.max(1, lw), theme, split ? 3 : 1, selected),
				];
				const right = [...result];
				if (!split && b.workers.length) right.push(`Worker · ${workerTitle(b.workers.at(-1)!)}`);
				if (split && b.workers.length) {
					right.push(section(theme, 'Workers'));
					for (const w of b.workers.slice(-3).reverse()) {
						right.push(workerTitle(w));
						if (w.error) right.push(theme.fg('error', `  ! ${clean(w.error)}`));
						else if (w.outputs) right.push(`  ↳ ${ports(w.outputs, 1)[0]}`);
					}
					if (b.workers.length > 3) right.push(`… +${b.workers.length - 3} workers`);
				}
				if (b.calls.length) {
					const calls = b.calls.slice(split ? -3 : -1).reverse();
					right.push(
						section(theme, '工具调用 · 按节点'),
						...calls.map((e) => callTitle(e, frame.drained || frame.historical)),
					);
				}
				const recentCount = split ? 4 : 2;
				right.push(
					section(theme, `最近事件 · ${Math.min(frame.steps.length, recentCount)}/${frame.steps.length}`),
					...frame.steps.slice(-recentCount).reverse().map(eventTitle),
				);
				// Surface the most recent node's typed ports even before the main result exists.
				if (!b.output) {
					const last = frame.steps.findLast((e) => e.type === 'node_finish');
					if (last?.type === 'node_finish') {
						if (split) right.push(section(theme, `输出 · ${clean(last.id)}`), ...ports(last.outputs, 2));
						else if (!result.length) right.push(`输出 · ${clean(last.id)} · ${ports(last.outputs, 1)[0]}`);
					}
				}
				lines.push(
					...(split ? combine(left, right, lw, theme) : [...right, ...left]),
					theme.fg('dim', `完整看板 · ${status}`),
				);
			}
			return (cached = lines.map((s) => fit(s, width)));
		},
	};
}

function overview(f: RunFrame, b: Board, t: Theme, w: number, includeGraph: boolean) {
	return [
		t.fg('dim', progress(f, b)),
		t.fg('dim', `Run · ${clean(f.id)}`),
		...resultInfo(f, b, t, Infinity),
		...(includeGraph ? [section(t, '拓扑 / 节点'), ...topology(f, b, w, t)] : []),
		...(b.workers.length ? [section(t, 'Workers'), ...b.workers.map(workerTitle)] : []),
		section(t, '事件 · 从新到旧'),
		...f.steps.slice().reverse().map(eventTitle),
	];
}
function detail(f: RunFrame, b: Board, n: NodeView, t: Theme) {
	const lines = [`[${clean(n.kind)}] ${b.badges.get(n.id)}`];
	if (n.state === '—') lines.push(f.omitted ? '保留的事件中没有此节点' : '尚无执行记录');
	if (n.error) lines.push(t.fg('error', clean(n.error)));
	if (n.gate) lines.push(`${clean(n.gate.question)} → ${n.gate.answer ? 'yes' : 'no'}`);
	for (const r of b.requests) if (r.node === n.id) lines.push(t.fg('warning', requestText(r)));
	if (b.gates.includes(n.id)) lines.push(`/flow answer ${clean(f.id)}`);
	if (n.join) {
		lines.push(section(t, 'Join · 已采纳的快照'));
		for (const [k, v] of Object.entries(n.join.snapshot ?? {})) {
			lines.push(`${clean(k)} · ${clean(v.status)}`);
			if (v.status === 'failed') lines.push(t.fg('error', clean(v.error)));
			if (v.status === 'succeeded') lines.push(...portTrees(v.outputs));
		}
	}
	const calls = b.calls.filter((e) => e.id === n.id);
	if (calls.length)
		lines.push(
			section(t, '工具调用 · 节点调用 ID'),
			...calls.map((e) => callTitle(e, f.drained || f.historical)),
			t.fg('dim', auditNote),
		);
	if (n.outputs) lines.push(section(t, n.kind === 'end' ? '结束端口' : '输出端口'), ...portTrees(n.outputs));
	if (f.graph) {
		for (const { from, to } of f.graph.edges)
			if (from[0] === n.id || to[0] === n.id) {
				lines.push(`${from.map(clean).join('.')} → ${to.map(clean).join('.')}`);
				const sent = b.nodes.get(from[0])?.outputs;
				if (to[0] === n.id && sent && Object.hasOwn(sent, from[1]))
					lines.push(...portTree(to[1], sent[from[1]], '  '));
			}
	} else lines.push(t.fg('dim', '无拓扑快照'));
	for (const w of b.workers)
		if (w.forkId === n.id || w.first === n.id) {
			lines.push(section(t, `Worker · ${workerTitle(w)}`));
			if (w.error) lines.push(t.fg('error', clean(w.error)));
			if (w.outputs) lines.push(...portTrees(w.outputs));
		}
	return lines;
}

/** Read-only, finite viewport. Navigation never answers gates, cancels or replays. */
export async function showRun(ctx: ExtensionCommandContext, get: () => RunFrame): Promise<void> {
	if (ctx.mode !== 'tui') {
		ctx.ui.notify('查看运行看板需要交互式 TUI；可用 flow_status 读取日志。', 'info');
		return;
	}
	let timer: ReturnType<typeof setInterval> | undefined;
	const stop = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};
	try {
		await ctx.ui.custom<void>(
			(tui, theme, keys, done) => {
				let f = get(),
					b = project(f),
					selected: string | undefined,
					offset = 0,
					page = 1;
				let readError = '',
					body: string[] | undefined,
					bodyWidth = -1;
				let graph: string[] = [],
					graphWidth = 0,
					graphOffset = 0,
					followSelection = true;
				type Hit = { id: string; first: number; last: number; x: number; columns: number };
				let hits: Hit[] = [];
				const invalidate = () => {
					body = undefined;
				};
				const refresh = () => {
					invalidate();
					tui.requestRender();
				};
				const settled = () => f.drained || f.historical || b.phase === 'interrupted';
				if (!settled())
					timer = setInterval(() => {
						try {
							f = get();
							b = project(f);
							if (settled()) stop();
						} catch (e) {
							readError = clean(e instanceof Error ? e.message : e);
							stop();
						}
						refresh();
					}, 500);
				function next(delta: number) {
					const ids = [...b.nodes.keys()];
					if (!ids.length) return;
					const i = selected === undefined ? (delta > 0 ? -1 : 0) : ids.indexOf(selected);
					select(ids[(i + delta + ids.length) % ids.length]);
				}
				function select(id?: string) {
					selected = id;
					offset = 0;
					followSelection = true;
					invalidate();
				}
				return {
					capturesViewportInput: true,
					invalidate,
					dispose: stop,
					render(width) {
						const h = Math.max(1, tui.terminal.rows),
							w = Math.max(1, width);
						const n = selected === undefined ? undefined : b.nodes.get(selected);
						const head = n
							? `${section(theme, clean(n.id))} · 节点 ${[...b.nodes.keys()].indexOf(n.id) + 1}/${b.nodes.size}`
							: title(f, b, theme);
						if (h === 1) return [fit(head, width)];
						page = Math.max(1, h - 2);
						// Wide: independently scrollable topology and detail. Narrow: Tab switches
						// overview / node so neither pane consumes half of a tiny viewport.
						const lw = f.graph && w >= 88 ? Math.floor((w - 3) * 0.45) : 0;
						const rw = lw ? w - lw - 3 : w;
						if (!body || bodyWidth !== w) {
							bodyWidth = w;
							graphWidth = lw;
							graph = [];
							hits = [];
							if (f.graph && lw)
								graph = [
									section(theme, '拓扑 / 节点'),
									...diagramLines(f.graph, lw, theme, {
										badges: b.badges,
										selected,
										onCard: (id, first, last, x, columns) =>
											hits.push({ id, first: first + 1, last: last + 1, x, columns }),
									}),
								];
							const raw = n ? detail(f, b, n, theme) : overview(f, b, theme, w, !lw);
							if (readError) raw.unshift(theme.fg('error', `读取中断 · ${readError}`));
							body = raw.flatMap((s) => wrapTextWithAnsi(s, rw).map((v) => fit(v, rw)));
						}
						const rows = Math.max(body.length, !n ? graph.length : 0);
						offset = Math.min(Math.max(0, offset), Math.max(0, rows - page));
						// Overview scroll covers the entire graph. In detail mode keep the selected
						// node in frame, even after a resize, without moving the right-hand text.
						if (!n) graphOffset = offset;
						else if (followSelection) {
							const hit = hits.find((c) => c.id === n.id);
							if (hit) graphOffset = Math.min(hit.first, Math.max(graphOffset, hit.last - page + 1));
						}
						graphOffset = Math.min(Math.max(0, graphOffset), Math.max(0, graph.length - page));
						const help = `Esc 退出 · ←→ 节点 · Tab ${selected ? '总览' : '详情'} · ↑↓/Pg 滚动  ${offset + 1}/${rows}`;
						let view = body.slice(offset, offset + page);
						if (lw) view = combine(graph.slice(graphOffset, graphOffset + page), view, lw, theme);
						while (view.length < page) view.push('');
						return [
							fit(head, width),
							...view.map((s) => fit(s, width)),
							...(h > 2 ? [fit(theme.fg('dim', help), width)] : []),
						];
					},
					handleInput(data) {
						if (keys.matches(data, 'tui.select.cancel') || matchesKey(data, 'q')) {
							stop();
							done();
							return;
						}
						if (matchesKey(data, Key.left)) next(-1);
						else if (matchesKey(data, Key.right)) next(1);
						else if (matchesKey(data, Key.tab)) {
							if (selected === undefined) next(1);
							else select();
						} else if (keys.matches(data, 'tui.select.down')) offset++;
						else if (keys.matches(data, 'tui.select.up')) offset--;
						else if (matchesKey(data, Key.pageDown)) offset += page;
						else if (matchesKey(data, Key.pageUp)) offset -= page;
						else if (matchesKey(data, Key.home)) offset = 0;
						else if (matchesKey(data, Key.end)) offset = Number.MAX_SAFE_INTEGER;
						else return;
						tui.requestRender();
					},
					handleMouse(event) {
						if (event.type === 'wheel' && event.wheelDelta) {
							if (selected && event.x < graphWidth) {
								followSelection = false;
								graphOffset += event.wheelDelta;
							} else offset += event.wheelDelta;
							return { handled: true };
						}
						if (
							event.button !== 'left' ||
							(event.type !== 'press' && event.type !== 'click') ||
							event.y < 1 ||
							event.y > page
						)
							return;
						const row = graphOffset + event.y - 1;
						const hit = hits.find(
							(c) => row >= c.first && row <= c.last && event.x >= c.x && event.x < c.x + c.columns,
						);
						if (!hit) return;
						if (event.type === 'click') select(hit.id);
						return { handled: true };
					},
				};
			},
			{ overlay: true, overlayOptions: { width: '100%', maxHeight: '100%' } },
		);
	} finally {
		stop();
	}
}
