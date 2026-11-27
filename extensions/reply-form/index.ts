import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Draft, formParams, parseForm, type Answer, type Form } from './model.ts';
import { createReplyUI } from './ui.ts';

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
			? '已切换为手写。没有提交答题卡或接受默认答案；请在原输入框回复。'
			: '当前没有交互式答题卡。请把以下问题作为普通消息呈现给用户，等待书面回复；不要代答或再次打开答题卡。';
	return result(`${notice}\n\n${lines.join('\n\n')}`, { status }, status === 'manual');
}
const interrupted = () => result('答题卡已中断；没有提交任何回答。', { status: 'interrupted' }, true);

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
	pi.on('before_agent_start', (event) => {
		if (event.messageType === 'user') awaitingWritten = false;
	});

	pi.registerTool({
		name: 'ask_form',
		label: '答题卡',
		description:
			'Ask the user for decisions or clarification using a paged reply form with single choice, multiple choice and text questions. A default is a suggestion, not consent. The user may submit a partial form. On confirmation, a blank uses its default if present, otherwise it is skipped. Do not infer consent or a value for skipped questions. If the user chooses manual input, wait for their written reply.',
		promptSnippet: 'Ask one or more questions in a reviewable, user-confirmed reply form.',
		promptGuidelines: [
			'When you need the user to answer questions or choose what to do, use ask_form with the related questions in a single call instead of a long prose questionnaire, unless the user prefers plain text. Call ask_form by itself, not alongside other tools; wait for the actual answers before acting.',
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
					{ blocked: { kind: 'question', message: '等待填写答题卡' } },
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
			return new Text(theme.fg('toolTitle', theme.bold('答题卡')), 0, 0);
		},
	});
}
