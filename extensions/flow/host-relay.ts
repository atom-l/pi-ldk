import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { FlowLocalTool } from './runtime-types.ts';

type Host = Pick<ExtensionContext, 'sessionManager'>;
type Manager = Host['sessionManager'];
type Outcome = { content: ToolResultMessage['content']; isError: boolean; terminate?: boolean };
export type HostRequest = {
	runId: string;
	node: string;
	requestId: string;
	tool: string;
	arguments: Record<string, unknown>;
};
type Receipt = {
	sourceEntry: string;
	invalid?: boolean;
	digest?: string;
	isError?: boolean;
	terminate?: boolean;
	needsId: boolean;
};
type Wait = {
	request: HostRequest;
	after: string;
	receipts: Map<string, Receipt>;
	finish(result: Outcome): void;
	cancel(): void;
};
// Only currently waiting requests participate. Never cache results or transcript entries across runs.
const waiting = new WeakMap<Manager, Set<Wait>>();
const ownControl = new Set(['flow_run', 'flow_continue', 'flow_status', 'flow_cancel']);
const sameArgs = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);

// Follow IDs only as far as the anchor. Never build model context or inspect earlier messages.
function since(manager: Manager, anchor: string): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let id = manager.getLeafId();
	while (id !== anchor) {
		const e = id && manager.getEntry(id);
		if (!e || entries.length >= 8192) throw new Error('Stale Flow host handoff: branch anchor not reachable');
		entries.push(e);
		id = e.parentId;
	}
	return entries.reverse();
}

// Keep ONLY model-visible content. In particular, don't relay details, usage, nested-call
// arguments, opaque signatures or any extra properties on a content block. Reject unknown blocks.
function publicContent(raw: unknown): Outcome['content'] | undefined {
	if (!Array.isArray(raw)) return;
	const content: Outcome['content'] = [];
	for (const block of raw) {
		if (block?.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text });
		else if (block?.type === 'image' && typeof block.mimeType === 'string' && typeof block.data === 'string')
			content.push({ type: 'image', mimeType: block.mimeType, data: block.data });
		else return;
	}
	return content;
}
const digest = (content: Outcome['content']) => createHash('sha256').update(JSON.stringify(content)).digest('hex');

/** One live run. Flow returns requests() to the *parent model* and yields the outer call.
 * There is deliberately no executeTool(), sendUserMessage(), tool implementation, or parent
 * provider context here. Only the parent can issue the requested top-level Pi tool call.
 * Call close() at drain/reset; do not journal requests() or try to reconstruct promises on reload. */
export class FlowHostRelay {
	private readonly manager: Manager;
	private readonly file?: string;
	private readonly sessionId?: string;
	private readonly root?: string | null;
	private readonly pending = new Map<string, Wait>();
	private readonly off: (() => void)[] = [];
	private closed = false;
	private readonly pi: ExtensionAPI;
	private readonly runId: string;
	private readonly changed: () => void;
	private readonly visible: (name: string) => boolean;

	constructor(pi: ExtensionAPI, ctx: Host, runId: string, onChange: () => void, visible = (_name: string) => true) {
		this.pi = pi;
		this.manager = ctx.sessionManager;
		this.runId = runId;
		this.changed = onChange;
		this.visible = visible;
		// A basic Flow does not require relay capability. Do not guess a session or
		// fall back to scanning a transcript if public registry/tree/events are absent.
		if (
			!this.manager ||
			typeof this.manager.getSessionFile !== 'function' ||
			typeof this.manager.getSessionId !== 'function' ||
			typeof this.manager.getLeafId !== 'function' ||
			typeof this.manager.getEntry !== 'function' ||
			typeof pi.getAllTools !== 'function' ||
			typeof pi.getActiveTools !== 'function' ||
			typeof pi.on !== 'function'
		)
			return;
		this.file = this.manager.getSessionFile(); // undefined in --no-session; never invent a path
		this.sessionId = this.manager.getSessionId();
		this.root = this.manager.getLeafId();
		if (!this.root || !this.sessionId) return;
		this.off = [
			pi.on('session_shutdown', () => this.close()),
			pi.on('session_tree', () => this.close()),
			pi.on('tool_execution_start', (e, current) => {
				if (e.parentToolCallId !== undefined || !this.sameSession(current.sessionManager)) return;
				for (const w of this.pending.values()) {
					if (e.toolName !== w.request.tool || !sameArgs(e.args, w.request.arguments)) continue;
					if (!this.allowed().some((t) => t.name === e.toolName)) continue;
					// Bind the event to its actual source message on this live branch. Identical
					// content on a different branch cannot stand in for a missing execution.
					let source: SessionEntry | undefined;
					try {
						source = since(this.manager, w.after)
							.reverse()
							.find(
								(entry) =>
									entry.type === 'message' &&
									(entry.message.role === 'assistant' || entry.message.role === 'user'),
							);
					} catch {
						continue;
					} // stale anchor: don't interfere with a real host call
					if (
						source?.type !== 'message' ||
						source.message.role !== 'assistant' ||
						!source.message.content.some(
							(c) =>
								c.type === 'toolCall' &&
								c.id === e.toolCallId &&
								c.name === e.toolName &&
								sameArgs(c.arguments, e.args),
						)
					)
						continue;
					if (w.receipts.size >= 128) {
						w.cancel();
						continue;
					}
					const overlap = [...(waiting.get(this.manager) ?? [])].some(
						(other) =>
							other !== w && other.request.tool === e.toolName && sameArgs(other.request.arguments, e.args),
					);
					w.receipts.set(e.toolCallId, {
						sourceEntry: source.id,
						needsId: overlap,
						invalid: w.receipts.has(e.toolCallId),
					});
				}
			}),
			pi.on('tool_result', (e, current) => {
				if (e.parentToolCallId !== undefined || !this.sameSession(current.sessionManager)) return;
				for (const w of this.pending.values()) {
					const r = w.receipts.get(e.toolCallId);
					if (r && (e.toolName !== w.request.tool || !sameArgs(e.input, w.request.arguments))) r.invalid = true;
				}
			}),
			pi.on('tool_execution_end', (e, current) => {
				if (e.parentToolCallId !== undefined || !this.sameSession(current.sessionManager)) return;
				for (const w of this.pending.values()) {
					const r = w.receipts.get(e.toolCallId);
					if (!r || r.invalid || w.request.tool !== e.toolName) continue;
					const content = publicContent(e.result?.content);
					if (!content || r.digest) r.invalid = true;
					else
						Object.assign(r, {
							digest: digest(content),
							isError: e.isError,
							terminate: e.result?.terminate === true,
						});
				}
			}),
		].filter((unsubscribe) => typeof unsubscribe === 'function');
		// A legacy shim may register listeners but return void; disable the relay.
		if (this.off.length !== 5) this.close();
	}

	private sameSession(manager: Manager) {
		return (
			!this.closed &&
			!!this.root &&
			manager === this.manager &&
			this.sessionId === this.manager.getSessionId() &&
			this.file === this.manager.getSessionFile()
		);
	}
	private allowed() {
		const active = new Set(this.pi.getActiveTools());
		return this.pi
			.getAllTools()
			.filter(
				(t) => t.exposure === 'model-only' && active.has(t.name) && !ownControl.has(t.name) && this.visible(t.name),
			);
	}
	localTools(node: string): FlowLocalTool[] {
		if (this.closed || !this.root || !this.sameSession(this.manager)) return [];
		// Check branch ancestry only when a handoff is actually requested. Ordinary
		// models and local tools must not walk (or fail on) a long parent branch.
		return this.allowed().map(({ name, description, parameters }) => ({
			name,
			description,
			parameters,
			execute: async (args, signal) => {
				signal.throwIfAborted();
				if (!this.sameSession(this.manager) || !this.allowed().some((t) => t.name === name))
					throw new Error('Host handoff tool is not available');
				since(this.manager, this.root!);
				const after = this.manager.getLeafId()!;
				const request: HostRequest = {
					runId: this.runId,
					node,
					requestId: randomUUID(),
					tool: name,
					arguments: structuredClone(args),
				};
				return new Promise<Outcome>((resolve, reject) => {
					const peers = waiting.get(this.manager) ?? new Set<Wait>();
					waiting.set(this.manager, peers);
					const remove = () => {
						signal.removeEventListener('abort', w.cancel);
						peers.delete(w);
						this.pending.delete(request.requestId);
					};
					const w: Wait = {
						request,
						after,
						receipts: new Map(),
						cancel: () => {
							remove();
							reject(new Error('Flow host handoff cancelled'));
							this.changed();
						},
						finish: (result) => {
							remove();
							resolve(result);
							this.changed();
						},
					};
					this.pending.set(request.requestId, w);
					peers.add(w);
					signal.addEventListener('abort', w.cancel, { once: true });
					this.changed();
				});
			},
		}));
	}
	requests(): HostRequest[] {
		return [...this.pending.values()].map((w) => structuredClone(w.request));
	}

	accept(ctx: Host, requestId: string, toolCallId?: string): boolean {
		if (!this.sameSession(ctx.sessionManager)) throw new Error('Stale Flow host handoff session');
		const w = this.pending.get(requestId);
		if (!w) return false;
		if (!this.allowed().some((t) => t.name === w.request.tool)) throw new Error('Host handoff permission withdrawn');
		const path = since(this.manager, w.after);
		// Don't recover content hidden by a context edit or compaction out of raw history.
		if (path.some((e) => e.type === 'compaction' || e.type === 'branch_summary')) return false;
		const edited = new Set(path.flatMap((e) => (e.type === 'context_edit' ? [e.targetId] : [])));
		const choices = [...w.receipts].filter(([id]) => toolCallId === undefined || id === toolCallId);
		if (choices.length !== 1) return false;
		const [id, r] = choices[0];
		if (!r.digest || r.invalid || (r.needsId && toolCallId === undefined)) return false;
		let calls = 0,
			results = 0,
			paired = false,
			outcome: Outcome | undefined;
		for (const e of path) {
			if (e.type !== 'message') continue;
			const m = e.message;
			if (m.role === 'user') paired = false;
			if (m.role === 'assistant') {
				paired = false;
				for (const c of m.content)
					if (c.type === 'toolCall' && c.id === id) {
						calls++;
						paired =
							e.id === r.sourceEntry &&
							!edited.has(e.id) &&
							m.stopReason === 'toolUse' &&
							c.argumentsError === undefined &&
							c.name === w.request.tool &&
							sameArgs(c.arguments, w.request.arguments);
					}
			} else if (m.role === 'toolResult' && m.toolCallId === id) {
				results++;
				if (!paired || m.toolName !== w.request.tool || edited.has(e.id) || m.isError !== r.isError) continue;
				const content = publicContent(m.content);
				if (content && digest(content) === r.digest)
					outcome = { content, isError: m.isError, ...(r.terminate ? { terminate: true } : {}) };
			}
		}
		if (calls !== 1 || results !== 1 || !outcome) return false;
		// Only currently overlapping requests could possibly have witnessed this execution.
		// Burn the receipt for all of them synchronously, before resolving any Action promise.
		for (const peer of waiting.get(this.manager) ?? []) {
			const receipt = peer.receipts.get(id);
			if (receipt) receipt.invalid = true;
		}
		w.finish(outcome);
		return true;
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		for (const off of this.off) off();
		for (const w of this.pending.values()) w.cancel();
	}
}
