import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Bag, Msg } from './contract.ts';
import type { Diagram } from './graph-lines.ts';
import type { RunFrame } from './run-board.ts';
import type { RunEvent } from './runner.ts';

// The runner's journal is the source of truth. Renderers get a small, independent
// projection; never feed truncated values back to the interpreter or the model.
export const RUN_ENTRY = 'ldk-flow-run-v1';
type Stamp = Pick<RunFrame, 'id' | 'name' | 'phase' | 'drained' | 'pending' | 'requests' | 'error' | 'output'>;
export type PresentationEntry = { id: string; summary?: Stamp; graph?: Diagram; step?: RunEvent };
const RECENT = 120;
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n) + '…');
function previewValue(v: unknown, budget: { left: number }, depth = 0): unknown {
	if (budget.left <= 0) return '…';
	if (typeof v === 'string') {
		const s = clip(v, Math.min(budget.left, 300));
		budget.left -= s.length;
		return s;
	}
	budget.left -= 8;
	if (!v || typeof v !== 'object') return v;
	if (depth >= 2) return Array.isArray(v) ? `[${v.length} 项]` : '{…}';
	if (Array.isArray(v))
		return [...v.slice(0, 6).map((x) => previewValue(x, budget, depth + 1)), ...(v.length > 6 ? ['…'] : [])];
	const parts: [string, unknown][] = [];
	for (const k in v)
		if (Object.hasOwn(v, k)) {
			if (parts.length >= 6 || budget.left <= 0) {
				parts.push(['…', '更多字段']);
				break;
			}
			const label = clip(k, 80);
			budget.left -= label.length;
			parts.push([label, previewValue((v as Record<string, unknown>)[k], budget, depth + 1)]);
		}
	return Object.fromEntries(parts);
}
function previewBag(b: Bag, budget = { left: 2400 }): Bag {
	const parts: [string, Msg][] = [];
	for (const k in b)
		if (Object.hasOwn(b, k)) {
			if (parts.length >= 12 || budget.left <= 0) break;
			const v = b[k];
			parts.push([k, { type: v.type, value: previewValue(v.value, budget) }]);
		}
	return Object.fromEntries(parts);
}
function previewStep(s: RunEvent): RunEvent {
	if ('outputs' in s) return { ...s, outputs: previewBag(s.outputs) };
	if ('error' in s) return { ...s, error: clip(s.error, 600) };
	if (s.type === 'join_close') {
		const budget = { left: 2400 };
		return {
			...s,
			snapshot: Object.fromEntries(
				Object.entries(s.snapshot)
					.slice(0, 24)
					.map(([k, w]) => [
						k,
						w.status === 'succeeded'
							? { ...w, outputs: previewBag(w.outputs, budget) }
							: w.status === 'failed'
								? { ...w, error: clip(w.error, 300) }
								: w,
					]),
			),
		};
	}
	return { ...s };
}
function apply(f: RunFrame, j: PresentationEntry, full = false) {
	if (j.graph) f.graph = j.graph;
	if (j.summary) {
		const s = j.summary;
		f.name = s.name;
		f.phase = s.phase;
		f.drained = s.drained;
		const canWait = !s.drained && ['running', 'waiting', 'succeeded'].includes(s.phase);
		f.pending = canWait ? [...s.pending] : [];
		// Copy only public prompt text, never relay arguments, tool results or form answers.
		f.requests = canWait
			? (s.requests ?? []).map(({ node, kind, question }) => ({
					node,
					kind,
					question: full ? question : clip(question, 600),
				}))
			: [];
		f.error = s.error && (full ? s.error : clip(s.error, 600));
		if (s.output) f.output = full ? s.output : previewBag(s.output);
	}
	if (j.step) {
		const step = j.step;
		if (step.type === 'run_cancelled' || step.type === 'run_failed') {
			f.pending = [];
			f.requests = [];
		} else if (step.type === 'node_cancelled') {
			f.pending = f.pending.filter((id) => id !== step.id);
			f.requests = f.requests?.filter((r) => r.node !== step.id);
		}
		f.steps.push(full ? step : previewStep(step));
		if (!full && f.steps.length > RECENT) {
			const old = f.steps.shift()!;
			f.omitted = (f.omitted ?? 0) + 1;
			if (old.type === 'action_tool_start' || old.type === 'action_tool_finish') {
				// Keep recent evidence visible when later deterministic steps fill the tail.
				const calls = (f.earlierTools ?? []).filter((c) => c.id !== old.id || c.callId !== old.callId);
				f.earlierTools = [...calls.slice(-2), old];
			}
			if ('kind' in old) {
				const state = {
					node_start: 'started',
					node_finish: 'done',
					node_failed: 'failed',
					node_pruned: 'pruned',
					node_cancelled: 'cancelled',
				}[old.type];
				const route =
					old.type === 'node_finish' && (old.kind === 'gate' || old.kind === 'decision')
						? Object.keys(old.outputs).join(', ')
						: undefined;
				(f.earlier ??= Object.create(null))[old.id] = { kind: old.kind, state, route };
			}
		}
	}
}
// An old tool result or detached viewer cannot issue requests on a dead caller.
export function markHistorical(f: RunFrame) {
	f.historical = true;
	f.pending = [];
	f.requests = [];
	if (!f.drained && (f.phase === 'waiting' || f.phase === 'running')) f.phase = 'interrupted';
	return f;
}
const blank = (id: string): RunFrame => ({ id, name: 'Flow', phase: 'running', drained: false, pending: [], steps: [] });
type Watch = (f: RunFrame) => void;
type Tracked = {
	frame: RunFrame;
	listeners: Map<string, Watch>;
	timer?: ReturnType<typeof setTimeout>;
	full?: { frame: RunFrame; users: number };
};

export function presentation() {
	const active = new Map<string, Tracked>(),
		cache = new Map<string, RunFrame>();
	let context: ExtensionContext | undefined;
	function cacheFrame(f: RunFrame) {
		cache.set(f.id, f);
		if (cache.size > 32) cache.delete(cache.keys().next().value!);
	}
	function emit(t: Tracked) {
		for (const cb of [...t.listeners.values()]) {
			try {
				cb(t.frame);
			} catch {
				/* presentation must not fail an action */
			}
		}
	}
	function update(j: PresentationEntry) {
		const t = active.get(j.id);
		if (!t) return;
		apply(t.frame, j);
		if (t.full) apply(t.full.frame, j, true);
		if (j.summary?.drained) {
			if (t.timer) clearTimeout(t.timer);
			active.delete(j.id);
			cacheFrame(t.frame);
			emit(t);
			t.listeners.clear();
			return;
		}
		if (!t.timer && t.listeners.size)
			t.timer = setTimeout(() => {
				t.timer = undefined;
				if (active.get(j.id) === t) emit(t);
			}, 60);
	}
	function open(id: string, ctx: ExtensionContext, graph: Diagram) {
		context = ctx;
		const frame = blank(id);
		frame.graph = graph;
		active.set(id, { frame, listeners: new Map() });
	}
	function reset(ctx?: ExtensionContext) {
		for (const t of active.values()) {
			if (t.timer) clearTimeout(t.timer);
			markHistorical(t.frame);
			if (t.full) markHistorical(t.full.frame);
			t.listeners.clear();
		}
		active.clear();
		cache.clear();
		context = ctx;
	}
	function watch(id: string, key: string, cb: Watch) {
		const t = active.get(id);
		if (t) t.listeners.set(key, cb);
		return () => {
			if (t?.listeners.get(key) === cb) t.listeners.delete(key);
		};
	}
	function get(id: string, full = false, ctx = context): RunFrame | undefined {
		const live = active.get(id)?.frame;
		if (!full) {
			const hit = live ?? cache.get(id);
			if (hit) return hit;
		}
		if (!ctx) return undefined;
		const f = blank(id);
		let found = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== 'custom' || entry.customType !== RUN_ENTRY) continue;
			const j = entry.data as PresentationEntry | undefined;
			if (j?.id !== id) continue;
			found = true;
			apply(f, j, full);
		}
		if (!found) return undefined;
		if (!live) markHistorical(f);
		if (!live && !full) cacheFrame(f);
		return f;
	}
	// Read the journal once on opening the detailed viewer, then append new events.
	// No timer scans the entire session history while a model or gate is waiting.
	function openFull(ctx: ExtensionContext, id: string) {
		const t = active.get(id);
		const frame = t?.full?.frame ?? get(id, true, ctx);
		if (!frame) throw new Error('本分支没有该运行');
		if (t) {
			t.full ??= { frame, users: 0 };
			t.full.users++;
		}
		return {
			frame,
			close() {
				if (t?.full && --t.full.users === 0) t.full = undefined;
			},
		};
	}
	return { open, update, reset, watch, get, openFull };
}
