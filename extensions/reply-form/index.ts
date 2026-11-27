import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Draft, FORM_LABEL, formParams, parseForm, type Answer, type Form } from './model.ts';
import { createReplyUI } from './ui.ts';

// Pi omits its standard tools/rules sections when a custom system prompt is used.
// A small, TUI-only section keeps the decision rule visible without changing the loadout.
const FORM_POLICY = [
	'需要用户拍板时，默认调用 ask_form，而不是在正文列问题。哪怕只有一个问题，也不必等用户点名表单。',
	'例如：由用户选择实施范围、在互斥方案中取舍，或补充无法从上下文查到的必要信息。选一项用 single，可选多项用 multi，自由回答用 text。把本轮相关问题合成一次调用，单独调用后等待答复。',
	'请求已经明确、答案可自行查证或用户已授权你判断时，直接推进，不制造问题。用户明确要求手写或纯文字时按其要求，不弹表单。',
].join('\n');

type Dismissal = 'manual' | 'unavailable' | 'interrupted';
type Details = { status: 'submitted'; answers: Answer[] } | { status: Dismissal };
type Outcome = 'submitted' | 'manual' | 'interrupted';

function result(body: string, details: Details, terminate = false): AgentToolResult<Details> {
	return { content: [{ type: 'text', text: body }], details, ...(terminate ? { terminate: true } : {}) };
}

// No values from Draft (not even effective defaults) cross the tool boundary on dismissal.
function written(form: Form, status: 'manual' | 'unavailable') {
	const lines = form.questions.map(
		(q, i) => `${i + 1}. ${q.prompt}${q.options ? `\n   选项：${q.options.join(' / ')}` : ''}`,
	);
	const notice =
		status === 'manual'
			? '已切换为手写。没有提交表单或接受默认答案；请在原输入框回复。'
			: `当前无法打开${FORM_LABEL}。请把以下问题作为普通消息呈现给用户，等待书面回复；不要代答或再次打开表单。`;
	return result(`${notice}\n\n${lines.join('\n\n')}`, { status }, status === 'manual');
}
const interrupted = () => result(`${FORM_LABEL}已中断；没有提交任何回答。`, { status: 'interrupted' }, true);

export default function replyFormExtension(pi: ExtensionAPI) {
	let active: AbortController | undefined;
	let awaitingWritten = false;
	const reset = () => {
		const previous = active;
		active = undefined;
		awaitingWritten = false;
		previous?.abort();
	};
	pi.on('session_start', reset);
	pi.on('session_shutdown', reset);
	pi.on('session_tree', reset);
	pi.on('before_agent_start', (event, ctx) => {
		if (event.messageType === 'user') awaitingWritten = false;
		const opts = event.systemPromptOptions;
		if (
			ctx.mode === 'tui' &&
			ctx.hasUI &&
			!awaitingWritten &&
			opts.forceSystemPrompt === undefined &&
			opts.selectedTools.includes('ask_form') &&
			!opts.hiddenTools.includes('ask_form')
		) {
			opts.sections.ldk_reply_form = FORM_POLICY;
		} else {
			delete opts.sections.ldk_reply_form;
		}
	});

	pi.registerTool({
		name: 'ask_form',
		label: FORM_LABEL,
		description:
			'Default interactive way to obtain a user-owned decision, preference, or missing requirement, even for a single question. Ask via single choice, multiple choice or free text; no need to ask permission to open the form first. A default is a suggestion, not consent. The user may submit a partial form. On confirmation, a blank uses its default if present, otherwise it is skipped. Do not infer consent or a value for skipped questions. If the user chooses manual input, wait for their written reply.',
		promptSnippet: 'Collect a needed user decision or clarification (one or more questions) in a reply form.',
		promptGuidelines: [
			'In the interactive terminal, use ask_form instead of asking for a decision in prose, even for one question. Batch related questions in one standalone call. Respect a request for plain text; when no user input is needed, proceed without asking.',
		],
		exposure: 'model-only',
		executionMode: 'sequential',
		parameters: formParams,
		async execute(_id, args, signal, _update, ctx) {
			if (signal?.aborted) return interrupted();
			const form = parseForm(args);
			if (ctx.mode !== 'tui' || !ctx.hasUI) return written(form, 'unavailable');
			if (awaitingWritten) return written(form, 'manual');
			if (active) throw new Error('Another reply form is already awaiting user input.');
			const draft = new Draft(form);
			const controller = new AbortController();
			active = controller;
			const abort = () => controller.abort();
			signal?.addEventListener('abort', abort, { once: true });
			let close: ((outcome: Outcome) => void) | undefined;
			const interrupt = () => close?.('interrupted');
			controller.signal.addEventListener('abort', interrupt, { once: true });
			try {
				const outcome = await ctx.ui.custom<Outcome>(
					(tui, theme, kb, done) => {
						close = done;
						if (controller.signal.aborted) {
							done('interrupted');
							return { render: () => [], invalidate() {} };
						}
						return createReplyUI(tui, theme, draft, done, kb);
					},
					{ blocked: { kind: 'question', message: `等待填写${FORM_LABEL}` } },
				);
				if (controller.signal.aborted || active !== controller) return interrupted();
				if (outcome === 'manual') {
					awaitingWritten = true;
					return written(form, 'manual');
				}
				if (outcome !== 'submitted') return interrupted();
				return result(draft.preview(), { status: 'submitted', answers: draft.answers() });
			} finally {
				close = undefined;
				controller.signal.removeEventListener('abort', interrupt);
				signal?.removeEventListener('abort', abort);
				if (active === controller) active = undefined;
			}
		},
		// Tool-call deltas are incomplete and have not been validated: do not render raw args here.
		renderCall(_args, theme) {
			return new Text(theme.fg('toolTitle', theme.bold(FORM_LABEL)), 0, 0);
		},
	});
}
