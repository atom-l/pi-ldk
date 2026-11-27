import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { Draft, formParams, parseForm } from '../reply-form/model.ts';
import { createReplyUI } from '../reply-form/ui.ts';
import type { Bag } from './contract.ts';
import { clean } from './graph-lines.ts';
import type { FlowLocalTool } from './runtime-types.ts';

// Deliberately not an ExtensionContext inside the bridge. No editor text, chat
// events, branch history, Pi tool registry, or executeTool capability is used.
type DialogHost = Pick<ExtensionContext, 'mode' | 'hasUI'> & { ui: Pick<ExtensionContext['ui'], 'select' | 'custom'> };
export type HumanScope = { runId: string; flow: string; node: string };
export type GateRequest = HumanScope & { question: string; inputs?: Bag };
const clip = (text: string, max: number) => clean(text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const label = (s: HumanScope) => `Flow ${clip(s.flow, 80)} · ${clip(s.node, 80)} · ${clip(s.runId, 40)}`;
const textResult = (text: string, isError = false) => ({
	content: [{ type: 'text' as const, text }],
	...(isError ? { isError } : {}),
});
export type GateChoice = boolean | 'handoff' | undefined;
const handoffLabel = '批准并交回主会话实施';

async function showGateText(ctx: DialogHost, request: GateRequest, signal: AbortSignal) {
	const raw = (request.question + '\n\n' + JSON.stringify(request.inputs ?? {}, null, 2)).split(/\r?\n/).map(clean);
	await ctx.ui.custom<void>(
		(tui, theme, _keys, done) => {
			let offset = 0,
				page = 1,
				cachedWidth = -1,
				lines: string[] = [];
			const stop = () => done();
			signal.addEventListener('abort', stop, { once: true });
			if (signal.aborted) done();
			return {
				capturesViewportInput: true,
				render(width) {
					if (width <= 0) return [];
					if (width !== cachedWidth) {
						lines = raw.flatMap((s) => wrapTextWithAnsi(s, width));
						cachedWidth = width;
					}
					page = Math.max(1, Math.min(22, tui.terminal.rows - 3));
					offset = Math.max(0, Math.min(offset, lines.length - page));
					return [
						theme.fg('accent', label(request)),
						...lines.slice(offset, offset + page),
						`↑↓/Pg 翻页 · Esc 返回审批（不作答） ${offset + 1}/${lines.length}`,
					]
						.slice(0, Math.max(1, tui.terminal.rows))
						.map((s) => truncateToWidth(s, width));
				},
				handleInput(data) {
					if (matchesKey(data, Key.escape)) {
						done();
						return;
					}
					if (matchesKey(data, Key.up)) offset--;
					else if (matchesKey(data, Key.down)) offset++;
					else if (matchesKey(data, Key.pageUp)) offset -= page;
					else if (matchesKey(data, Key.pageDown)) offset += page;
					else if (matchesKey(data, Key.home)) offset = 0;
					else if (matchesKey(data, Key.end)) offset = lines.length;
					else return;
					tui.requestRender();
				},
				invalidate() {
					cachedWidth = -1;
				},
				dispose() {
					signal.removeEventListener('abort', stop);
				},
			};
		},
		{ blocked: { kind: 'question', message: '查看 Flow 审批原文' } },
	);
}
const dismissed = () =>
	textResult('用户取消了本 Action 的提问。没有提交任何答案或接受默认值；不要代答、读取主聊天或再次打开表单。');

/** One FIFO per initiating session (shared by ALL its runs, gates and forms).
 * Runner owns gate identities: abort this request on cancellation, branch reset
 * or resolution via another route. Never translate a dismissal into a route. */
export class FlowHumanUI {
	private busy = false;
	private waiting = new Set<() => void>();

	private async turn<T>(signal: AbortSignal, show: () => Promise<T>): Promise<T> {
		signal.throwIfAborted();
		if (this.busy) {
			await new Promise<void>((resolve, reject) => {
				const grant = () => {
					this.waiting.delete(grant);
					signal.removeEventListener('abort', cancel);
					resolve();
				};
				const cancel = () => {
					this.waiting.delete(grant);
					reject(signal.reason);
				};
				this.waiting.add(grant);
				signal.addEventListener('abort', cancel, { once: true });
			});
		}
		this.busy = true;
		try {
			signal.throwIfAborted(); // may abort between grant and resuming this task
			const result = await show();
			signal.throwIfAborted(); // never accept a stale host callback
			return result;
		} finally {
			const next = this.waiting.values().next().value;
			if (next)
				next(); // transfer ownership without letting a new arrival jump ahead
			else this.busy = false;
		}
	}

	async gate(ctx: DialogHost, request: GateRequest, signal: AbortSignal): Promise<GateChoice> {
		signal.throwIfAborted();
		if (!ctx.hasUI || ctx.mode !== 'tui') return undefined;
		return this.turn(signal, async () => {
			const title = [
				`${label(request)} · 人工关口`,
				clip(request.question, 240),
				...(request.inputs ? [`输入预览：${clip(JSON.stringify(request.inputs), 180)}`] : []),
				`Esc 暂不决定，返回主聊天。稍后可用 /flow answer ${clip(request.runId, 40)}`,
			].join('\n');
			// An unsolicited Enter in the editor must never approve (or reject) a gate.
			for (;;) {
				signal.throwIfAborted();
				const choice = await ctx.ui.select(title, ['暂不决定', '批准', '拒绝', handoffLabel, '查看完整输入'], {
					signal,
					blockedKind: 'question',
				});
				if (choice === '查看完整输入') {
					await showGateText(ctx, request, signal);
					continue;
				}
				return choice === '批准'
					? true
					: choice === '拒绝'
						? false
						: choice === handoffLabel
							? 'handoff'
							: undefined;
			}
		});
	}

	/** A run-owned request UI, not a way to execute Pi's model-only ask_form.
	 * The host integration decides whether to expose this capability. Construct
	 * once per Action invocation so a dismissed form stays dismissed on retry. */
	askTool(ctx: DialogHost, scope: HumanScope): FlowLocalTool {
		let cancelled = false;
		return {
			name: 'flow_ask_form',
			description:
				'Ask the initiating user a decision or clarification for this Flow Action. Uses single, multiple or text questions. Only confirmed submission accepts answers/defaults; skipped questions and cancelled requests are not consent. Do not repeat a cancelled request.',
			parameters: formParams,
			execute: async (args, signal) => {
				signal.throwIfAborted();
				if (cancelled) return dismissed();
				if (!ctx.hasUI || ctx.mode !== 'tui')
					return textResult('此 Action 需要发起会话的 TUI 才能提问；未提交任何答案。', true);
				const form = parseForm(args);
				return this.turn(signal, async () => {
					if (cancelled) return dismissed();
					const draft = new Draft(form);
					type Outcome = 'submitted' | 'manual' | 'interrupted';
					let close: ((outcome: Outcome) => void) | undefined;
					const abort = () => close?.('interrupted');
					signal.addEventListener('abort', abort, { once: true });
					try {
						const outcome = await ctx.ui.custom<Outcome>(
							(tui, theme, kb, done) => {
								close = done;
								if (signal.aborted) {
									done('interrupted');
									return { render: () => [], invalidate() {} };
								}
								return createReplyUI(tui, theme, draft, done, kb, {
									contextLabel: label(scope),
									escapeLabel: '取消提问',
								});
							},
							{ blocked: { kind: 'question', message: '等待填写 Flow Action 回复表单' } },
						);
						signal.throwIfAborted();
						if (outcome === 'submitted') return textResult(draft.preview());
						if (outcome === 'manual') {
							cancelled = true;
							return dismissed();
						}
						return textResult('Action 回复表单已中断；未提交任何答案。', true);
					} finally {
						close = undefined;
						signal.removeEventListener('abort', abort);
					}
				});
			},
		};
	}
}
