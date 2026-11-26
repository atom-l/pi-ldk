import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import {
	Editor,
	Key,
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
import { type Draft, MAX_TEXT_LENGTH } from './model.ts';

type Page = 'question' | 'preview' | 'confirm' | 'reset';
const kindLabels = { single: '单选', multi: '多选', text: '文本' };
const pasteStart = '\x1b[200~',
	pasteEnd = '\x1b[201~';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Draft.preview() is the payload. Unlike prose word-wrap, preserve even runs of
// spaces, indentation, empty lines and trailing spaces at soft line breaks.
function previewLines(text: string, width: number): string[] {
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
): Component & Focusable {
	const { questions, title } = draft.form;
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
		resetFrom: 'question' | 'preview' = 'question';
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
	question(0);

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
		if (matchesKey(data, Key.escape)) return end('manual');
		// ProcessTerminal supplies a complete bracketed paste event. Only the
		// text page accepts one; pasted keys (including Y) are never actions.
		if (data.startsWith(pasteStart)) {
			if (page === 'question' && editor && data.endsWith(pasteEnd)) {
				if (data.length - pasteStart.length - pasteEnd.length > 2 * MAX_TEXT_LENGTH)
					notice = '粘贴过长；已保留原答案。';
				else editor.insertTextAtCursor(data.slice(pasteStart.length, -pasteEnd.length));
			}
			return;
		}
		if (page === 'confirm' || page === 'reset') {
			const letter = (key: 'y' | 'n') => matchesKey(data, key) || matchesKey(data, Key.shift(key));
			if (letter('n')) page = page === 'confirm' ? 'preview' : resetFrom;
			else if (letter('y')) {
				if (page === 'confirm') return end('submitted');
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
			if (page === 'preview' || index > 0) question(page === 'preview' ? index : index - 1);
			return;
		}
		if (page === 'preview') {
			if (matchesKey(data, Key.enter)) {
				const bad = questions.findIndex((_, i) => draft.problem(i) !== undefined);
				if (bad !== -1) {
					question(bad);
					notice = draft.problem(bad)!;
				} else page = 'confirm';
			} else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
			else if (matchesKey(data, Key.down)) offset++;
			else if (matchesKey(data, Key.home)) offset = 0;
			else if (matchesKey(data, Key.end)) offset = Number.MAX_SAFE_INTEGER;
			return;
		}
		if (matchesKey(data, Key.ctrl('p'))) return showPreview();
		if (matchesKey(data, Key.tab)) {
			notice = draft.problem(index) ?? '';
			if (!notice) {
				if (index + 1 < questions.length) question(index + 1);
				else showPreview();
			}
			return;
		}
		if (editor) {
			// Editor.setText(prefill) creates an undo entry; it is not a user edit.
			if (editorPristine && keybindings.matches(data, 'tui.editor.undo')) return;
			if (matchesKey(data, Key.enter)) editor.insertTextAtCursor('\n');
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
		if (page === 'confirm' || page === 'reset') {
			const confirm = page === 'confirm';
			return [
				...fg('warning', confirm ? '确认提交？' : '重新作答？'),
				...wrap(confirm ? 'Y 提交刚刚预览的整份答案' : 'Y 清空所有修改、恢复默认，从第一题重填'),
				...fg('muted', `N ${confirm ? '返回预览' : '取消重填'} · Esc 退出手写（不提交）`),
			];
		}
		const q = questions[index],
			inPreview = page === 'preview';
		const heading = inPreview
			? '提交预览'
			: `答题卡  ${index + 1}/${questions.length} · ${kindLabels[q.kind]} · ${q.required ? '必答' : '可跳过'}`;
		const footer = inPreview
			? '↑↓ 滚动 · Shift+Tab 回改 · Enter 确认 · Ctrl+R 重填 · Esc 手写'
			: `${editor ? 'Enter 换行' : '↑↓ 移动 · 空格选择 · 退格清空'} · Tab ${index + 1 === questions.length ? '预览' : '下一题'} · Shift+Tab 上一题 · Ctrl+P 预览 · Ctrl+R 重填 · Esc 手写`;
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
			editorLines = editor.render(Math.max(minEditorWidth, width));
		}
		// Don't let wrapped key hints push the answer off a small screen.
		if (header.length + help.length + editorLines.length + warning.length + 7 > tui.terminal.rows) {
			header = [theme.fg('accent', inPreview ? '提交预览' : `${index + 1}/${questions.length} ${kindLabels[q.kind]}`)];
			help = [
				theme.fg('muted', inPreview ? '↑↓ 滚动 · Enter 确认 · Esc 手写' : 'Tab 继续 · Shift+Tab 回改 · Esc 手写'),
			];
		}
		let body: string[] = [],
			anchor = 0;
		if (inPreview) {
			if (cachedPreview?.width !== width) cachedPreview = { width, lines: previewLines(preview, width) };
			body = cachedPreview.lines;
		} else {
			if (title !== '答题卡') body.push(...fg('dim', title));
			body.push(...wrap(q.prompt));
			const value = draft.value(index);
			q.options?.forEach((option, k) => {
				if (k === cursor) anchor = body.length;
				const selected = Array.isArray(value) ? value.includes(option) : value === option;
				const marker = q.kind === 'multi' ? (selected ? '[x]' : '[ ]') : selected ? '(●)' : '( )';
				body.push(...fg(k === cursor ? 'accent' : 'text', `${k === cursor ? '>' : ' '} ${marker} ${option}`));
			});
			if (q.default !== undefined) body.push(...fg('dim', '未修改时使用本题默认值'));
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
		render,
		invalidate() {
			editor?.invalidate();
			cachedPreview = undefined;
		},
	};
}
