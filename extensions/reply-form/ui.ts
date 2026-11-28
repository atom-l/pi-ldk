import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import {
	Editor,
	Key,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type EditorTheme,
	type Focusable,
	type TUI,
	type KeybindingsManager,
} from '@earendil-works/pi-tui';
import { markdownSourceFrame } from '../markdown-editor/editor.ts';
import { type Draft, FORM_LABEL, MAX_TEXT_LENGTH } from './model.ts';

type Page = 'question' | 'preview' | 'confirm' | 'reset';
const kindLabels = { single: '单选', multi: '多选', text: '文本（支持 Markdown）' };
const pasteStart = '\x1b[200~',
	pasteEnd = '\x1b[201~';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Draft.preview() is the payload. Unlike prose word-wrap, preserve even runs of
// spaces, indentation, empty lines and trailing spaces at soft line breaks.
export function previewLines(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const logical of text.split('\n')) {
		if (visibleWidth(logical) <= width) {
			lines.push(logical);
			continue;
		}
		let line = '',
			cells = 0;
		for (const { segment } of graphemes.segment(logical)) {
			const n = visibleWidth(segment);
			if (cells && cells + n > width) {
				lines.push(line);
				line = '';
				cells = 0;
			}
			line += segment;
			cells += n;
		}
		lines.push(line);
	}
	return lines;
}

export function createReplyUI(
	tui: TUI,
	theme: Theme,
	draft: Draft,
	finish: (outcome: 'submitted' | 'manual') => void,
	keybindings: KeybindingsManager,
	// Embedded requests may dismiss instead of handing control to the main chat editor.
	presentation?: { contextLabel: string; escapeLabel: string },
): Component & Focusable {
	const { questions, title } = draft.form;
	const escapeLabel = presentation?.escapeLabel ?? '手写';
	const color = (name: ThemeColor) => (s: string) => theme.fg(name, s);
	const editorTheme: EditorTheme = {
		borderColor: color('accent'),
		selectList: {
			selectedPrefix: color('accent'),
			selectedText: color('accent'),
			description: color('muted'),
			scrollInfo: color('dim'),
			noMatch: color('warning'),
		},
	};
	let page: Page = 'question',
		resetFrom: 'question' | 'preview' = 'question',
		confirmFrom: Exclude<Page, 'confirm'> = 'question';
	let index = 0,
		cursor = 0,
		offset = 0,
		windowSize = 1,
		followCursor = false;
	let focused = false,
		finished = false,
		notice = '';
	let editor: Editor | undefined,
		editorPristine = true;
	let measuredText: string | undefined,
		minEditorWidth = 3;
	let preview = '',
		cachedPreview: { width: number; lines: string[] } | undefined;

	function openEditor() {
		editorPristine = true;
		const e = new Editor(tui, editorTheme);
		e.disableSubmit = true;
		e.focused = focused;
		const value = draft.value(index);
		e.setText(typeof value === 'string' ? value : '');
		// Only edits after initialization mark an answer as user-provided.
		e.onChange = () => {
			try {
				draft.set(index, e.getExpandedText());
				editorPristine = false;
				notice = '';
			} catch (error) {
				// Never render rejected bytes. Recreate rather than setText (undo
				// could otherwise bring back rejected input / cross question pages).
				notice = error instanceof Error ? error.message : '输入无效；已保留原答案。';
				openEditor();
			}
		};
		editor = e;
	}

	function question(i: number) {
		page = 'question';
		index = i;
		notice = '';
		offset = 0;
		followCursor = false;
		const q = questions[i],
			value = draft.value(i);
		cursor = Math.max(0, q.options?.indexOf(Array.isArray(value) ? value[0] : (value ?? '')) ?? 0);
		editor = undefined;
		if (q.kind === 'text') openEditor();
	}
	question(0); // The first question cannot depend on an earlier one.

	// index is always the original draft index; only the route and progress change.
	function adjacent(step: -1 | 1) {
		const visible = draft.visibleIndices();
		return visible[visible.indexOf(index) + step];
	}

	function showPreview() {
		page = 'preview';
		preview = draft.preview();
		cachedPreview = undefined;
		offset = 0;
		notice = '';
		followCursor = false;
	}
	function end(outcome: 'submitted' | 'manual') {
		finished = true;
		finish(outcome);
	}
	function input(data: string) {
		// ProcessTerminal supplies a complete bracketed paste event. A pasted
		// Enter/escape sequence must never request, confirm or dismiss a submission.
		if (data.startsWith(pasteStart)) {
			if (page === 'question' && editor && data.endsWith(pasteEnd)) {
				if (data.length - pasteStart.length - pasteEnd.length > 2 * MAX_TEXT_LENGTH)
					notice = '粘贴过长；已保留原答案。';
				else editor.insertTextAtCursor(data.slice(pasteStart.length, -pasteEnd.length));
			}
			return;
		}
		// A held or released shortcut must not accept or dismiss a second dialog.
		const escape = matchesKey(data, Key.escape);
		const requestSubmit = matchesKey(data, Key.shift('enter'));
		const enter = matchesKey(data, Key.enter);
		if (
			isKeyRelease(data) ||
			(isKeyRepeat(data) && (escape || requestSubmit || (enter && (page === 'confirm' || page === 'reset'))))
		)
			return;
		if (page === 'confirm') {
			if (escape) page = confirmFrom;
			else if (enter) end('submitted');
			return;
		}
		if (escape) {
			if (page === 'reset') page = resetFrom;
			else end('manual');
			return;
		}
		if (requestSubmit) {
			confirmFrom = page;
			page = 'confirm';
			return;
		}
		if (page === 'reset') {
			if (enter) {
				draft.reset();
				question(0);
			}
			return;
		}
		if (matchesKey(data, Key.ctrl('r'))) {
			resetFrom = page;
			page = 'reset';
			return;
		}
		if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.pageUp)) {
			offset = Math.max(0, offset + (matchesKey(data, Key.pageDown) ? windowSize : -windowSize));
			followCursor = false;
			return;
		}
		if (matchesKey(data, Key.shift('tab'))) {
			const previous = page === 'preview' ? index : adjacent(-1);
			if (previous !== undefined) question(previous);
			return;
		}
		if (page === 'preview') {
			if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
			else if (matchesKey(data, Key.down)) offset++;
			else if (matchesKey(data, Key.home)) offset = 0;
			else if (matchesKey(data, Key.end)) offset = Number.MAX_SAFE_INTEGER;
			return;
		}
		if (matchesKey(data, Key.ctrl('p'))) return showPreview();
		if (matchesKey(data, Key.tab)) {
			const next = adjacent(1);
			if (next !== undefined) question(next);
			else showPreview();
			return;
		}
		if (editor) {
			// Editor.setText(prefill) creates an undo entry; it is not a user edit.
			if (editorPristine && keybindings.matches(data, 'tui.editor.undo')) return;
			if (enter) editor.insertTextAtCursor('\n');
			else editor.handleInput(data);
			return;
		}
		const q = questions[index],
			opts = q.options!;
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			cursor = Math.max(0, Math.min(opts.length - 1, cursor + (matchesKey(data, Key.up) ? -1 : 1)));
			followCursor = true;
		} else if (matchesKey(data, Key.backspace)) {
			draft.set(index, q.kind === 'multi' ? [] : '');
			notice = '';
			followCursor = true;
		} else if (matchesKey(data, Key.space)) {
			const option = opts[cursor],
				value = draft.value(index);
			if (q.kind === 'single') draft.set(index, option);
			else {
				const selected = Array.isArray(value) ? value : [];
				draft.set(index, selected.includes(option) ? selected.filter((v) => v !== option) : [...selected, option]);
			}
			notice = '';
			followCursor = true;
		}
	}

	function render(width: number): string[] {
		// A double-cell CJK grapheme cannot be painted at all in one column.
		if (width < 2) return [width > 0 ? '>' : ''];
		const wrap = (s: string) => wrapTextWithAnsi(s, width);
		const fg = (c: ThemeColor, s: string) => wrap(s).map(color(c));
		if (page === 'confirm') {
			const answers = draft.answers();
			const counts = { user: 0, default: 0, skipped: 0 };
			for (const { source } of answers) counts[source]++;
			const complete = counts.user === answers.length;
			return [
				...fg(complete ? 'accent' : 'warning', complete ? '确认提交？' : '未全部作答，确认提交？'),
				...wrap(
					complete
						? `已全部作答，共 ${counts.user} 题。`
						: `已作答 ${counts.user} 题，采用默认值 ${counts.default} 题，留空 ${counts.skipped} 题。`,
				),
				...fg('muted', 'Enter 确认提交 · Esc 取消并返回原页'),
			];
		}
		if (page === 'reset') {
			return [
				...fg('warning', '重新作答？'),
				...wrap('将清除本次修改、恢复默认值，从第一题重填。'),
				...fg('muted', 'Enter 确认重填 · Esc 取消并返回原页 · Shift+Enter 提交现有答案'),
			];
		}
		const q = questions[index],
			inPreview = page === 'preview',
			visible = draft.visibleIndices(),
			position = visible.indexOf(index) + 1,
			progress = `${position}/${visible.length}`;
		const heading = inPreview
			? '提交预览'
			: `${FORM_LABEL}  ${progress} · ${kindLabels[q.kind]} · ${q.required ? '建议作答' : '选填'}`;
		const footer = inPreview
			? `↑↓ 滚动 · Shift+Tab 回改 · Shift+Enter 提交 · Ctrl+R 重填 · Esc ${escapeLabel}`
			: `${editor ? 'Enter 换行' : '↑↓ 移动 · 空格选择 · 退格清空'} · Tab ${position === visible.length ? '预览' : '下一题'} · Shift+Tab 上一题 · Ctrl+P 预览 · Shift+Enter 提交 · Ctrl+R 重填 · Esc ${escapeLabel}`;
		let header = fg('accent', heading),
			help = fg('muted', footer);
		const warning = notice ? fg('warning', notice) : [];
		let editorLines: string[] = [];
		if (!inPreview && editor) {
			// Pi reserves one cursor column. Its word wrap cannot split a single wide
			// grapheme (e.g. CJK on a 2-column terminal); never give it that layout.
			const value = editor.getText();
			if (value !== measuredText) {
				measuredText = value;
				minEditorWidth = 3;
				for (const { segment } of graphemes.segment(value))
					minEditorWidth = Math.max(minEditorWidth, 1 + visibleWidth(segment));
			}
			// Reuse /md's source rendering only. This field has no command provider or chat submit action.
			editorLines = markdownSourceFrame(editor, editor.render(Math.max(minEditorWidth, width)));
		}
		// Don't let wrapped key hints push the answer off a small screen.
		if (header.length + help.length + editorLines.length + warning.length + 7 > tui.terminal.rows) {
			header = [theme.fg('accent', inPreview ? '提交预览' : `${progress} ${kindLabels[q.kind]}`)];
			help = [
				theme.fg(
					'muted',
					inPreview ? `Shift+Enter 提交 · ↑↓ 滚动 · Esc ${escapeLabel}` : `Shift+Enter 提交 · Tab 继续 · Esc ${escapeLabel}`,
				),
			];
		}
		let body: string[] = [],
			anchor = 0;
		if (inPreview) {
			if (cachedPreview?.width !== width) cachedPreview = { width, lines: previewLines(preview, width) };
			body = cachedPreview.lines;
		} else {
			if (title !== FORM_LABEL) body.push(...fg('dim', title));
			body.push(...wrap(q.prompt));
			const value = draft.value(index);
			q.options?.forEach((option, k) => {
				if (k === cursor) anchor = body.length;
				const selected = Array.isArray(value) ? value.includes(option) : value === option;
				const marker = q.kind === 'multi' ? (selected ? '[x]' : '[ ]') : selected ? '(●)' : '( )';
				body.push(...fg(k === cursor ? 'accent' : 'text', `${k === cursor ? '>' : ' '} ${marker} ${option}`));
			});
			if (q.default !== undefined) body.push(...fg('dim', '此题留空时将采用默认值'));
		}
		// Leave room for the host footer. The body (including the full prompt
		// and each option's continuation lines) can always be paged manually.
		windowSize = Math.max(
			1,
			Math.min(20, tui.terminal.rows - 5 - header.length - editorLines.length - warning.length - help.length - 1),
		);
		if (followCursor && (anchor < offset || anchor >= offset + windowSize)) offset = anchor;
		offset = Math.max(0, Math.min(offset, body.length - windowSize));
		const range =
			body.length > windowSize
				? [
						theme.fg(
							'dim',
							`${offset + 1}–${Math.min(offset + windowSize, body.length)}/${body.length} · PgUp/PgDn 翻页`,
						),
					]
				: [];
		return [...header, ...body.slice(offset, offset + windowSize), ...range, ...editorLines, ...warning, ...help].map(
			(line) => truncateToWidth(line, width, ''),
		);
	}
	return {
		get focused() {
			return focused;
		},
		set focused(v) {
			focused = v;
			if (editor) editor.focused = v;
		},
		capturesViewportInput: true,
		handleInput(data) {
			if (!finished) {
				input(data);
				if (!finished) tui.requestRender();
			}
		},
		render(width) {
			const lines = render(width);
			return presentation && width > 1
				? [theme.fg('accent', truncateToWidth(presentation.contextLabel, width, '…')), ...lines]
				: lines;
		},
		invalidate() {
			editor?.invalidate();
			cachedPreview = undefined;
		},
	};
}
