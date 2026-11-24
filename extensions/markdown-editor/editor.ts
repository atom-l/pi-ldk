import { CustomEditor, getMarkdownTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorTheme, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";

/** CSI/OSC/APC sequences, including Pi's APC cursor markers, are never source text. */
const ANSI_SEQUENCE_SOURCE = String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[_P^][^\x07\x1b]*(?:\x07|\x1b\\))`;
const INLINE_MARKDOWN_TOKEN =
	/(`+[^`\r\n]*`+|!\[[^\]\r\n]*\]\([^)\r\n]+\)|\[[^\]\r\n]*\]\([^)\r\n]+\)|https?:\/\/[^\s<]+|\*\*[^*\r\n]+\*\*|__[^_\r\n]+__|~~[^~\r\n]+~~|\*[^*\s][^*\r\n]*\*|_[^_\s][^_\r\n]*_)/g;

function ansiSequence(): RegExp {
	return new RegExp(ANSI_SEQUENCE_SOURCE, "g");
}

/**
 * Style the complete plain line, then put native cursor/control sequences back at
 * their original text offsets. Styling segments independently would break code
 * tokens whenever the hardware cursor crosses a keyword or string.
 */
function transformPreservingControls(line: string, transform: (plain: string) => string): string {
	const controls: Array<{ offset: number; value: string }> = [];
	let plain = "";
	let sourceOffset = 0;
	const sourceAnsi = ansiSequence();
	let sourceMatch: RegExpExecArray | null;
	while ((sourceMatch = sourceAnsi.exec(line)) !== null) {
		plain += line.slice(sourceOffset, sourceMatch.index);
		controls.push({ offset: plain.length, value: sourceMatch[0] });
		sourceOffset = sourceMatch.index + sourceMatch[0].length;
	}
	plain += line.slice(sourceOffset);

	const styled = transform(plain);
	// A renderer that changes the source text cannot be mapped back safely.
	if (styled.replace(ansiSequence(), "") !== plain) return line;
	if (controls.length === 0) return styled;

	let result = "";
	let plainOffset = 0;
	let styledOffset = 0;
	let controlIndex = 0;
	const appendPlain = (text: string): void => {
		let cursor = 0;
		while (controlIndex < controls.length) {
			const control = controls[controlIndex];
			const relative = control.offset - plainOffset;
			if (relative > text.length) break;
			result += text.slice(cursor, relative) + control.value;
			cursor = relative;
			controlIndex++;
		}
		result += text.slice(cursor);
		plainOffset += text.length;
	};

	const styledAnsi = ansiSequence();
	let styledMatch: RegExpExecArray | null;
	while ((styledMatch = styledAnsi.exec(styled)) !== null) {
		appendPlain(styled.slice(styledOffset, styledMatch.index));
		result += styledMatch[0];
		styledOffset = styledMatch.index + styledMatch[0].length;
	}
	appendPlain(styled.slice(styledOffset));
	while (controlIndex < controls.length) result += controls[controlIndex++].value;
	return result;
}

function styleInlineToken(token: string, theme: MarkdownTheme): string {
	if (token.startsWith("`")) return theme.code(token);
	if (token.startsWith("**") || token.startsWith("__")) return theme.bold(token);
	if (token.startsWith("~~")) return theme.strikethrough(token);
	if (token.startsWith("*") || token.startsWith("_")) return theme.italic(token);
	if (/^https?:/.test(token)) return theme.link(theme.underline(token));
	const link = /^(!?)\[([^\]\r\n]*)\]\(([^)\r\n]+)\)$/.exec(token);
	if (link) {
		const [, image, label, url] = link;
		return `${image}[${theme.link(theme.underline(label))}](${theme.linkUrl(url)})`;
	}
	return token;
}

function styleInlineMarkdown(text: string, theme: MarkdownTheme): string {
	return text.replace(INLINE_MARKDOWN_TOKEN, (token) => styleInlineToken(token, theme));
}

function styleMarkdownPlainLine(plain: string, theme: MarkdownTheme): string {
	const heading = /^\s*(#{1,6})[ \t]+/.exec(plain);
	if (heading) {
		// Match Pi's transcript headings: H1 is bold + underlined, deeper
		// headings are bold, all use the current mdHeading theme color.
		return heading[1].length === 1
			? theme.heading(theme.bold(theme.underline(plain)))
			: theme.heading(theme.bold(plain));
	}
	if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(plain)) {
		return theme.hr(plain);
	}
	const quote = /^(\s*)(>[ \t]?)(.*)$/.exec(plain);
	if (quote) return quote[1] + theme.quoteBorder(quote[2]) + theme.quote(quote[3]);
	const list = /^(\s*)([-+*]|\d{1,9}[.)])([ \t]+|$)(.*)$/.exec(plain);
	if (list) {
		return list[1] + theme.listBullet(list[2]) + list[3] + styleInlineMarkdown(list[4], theme);
	}
	return styleInlineMarkdown(plain, theme);
}

/** Highlight a rendered source line using Pi's own Markdown and code themes. */
export function highlightMarkdownLine(
	line: string,
	inFence = false,
	language?: string,
	theme: MarkdownTheme = getMarkdownTheme(),
): { text: string; inFence: boolean; language?: string } {
	const plain = line.replace(ansiSequence(), "");
	const fence = /^\s*(`{3,}|~{3,})([^\r\n]*)$/.exec(plain);
	if (fence) {
		const nextLanguage = inFence ? undefined : fence[2].trim().split(/\s+/, 1)[0] || undefined;
		return {
			text: transformPreservingControls(line, theme.codeBlockBorder),
			inFence: !inFence,
			language: nextLanguage,
		};
	}
	if (inFence) {
		return {
			text: transformPreservingControls(line, (code) => {
				const highlighted = theme.highlightCode?.(code, language);
				return highlighted?.length === 1 ? highlighted[0] : theme.codeBlock(code);
			}),
			inFence,
			language,
		};
	}
	return {
		text: transformPreservingControls(line, (text) => styleMarkdownPlainLine(text, theme)),
		inFence,
		language,
	};
}

/** Only highlight the native source rows; autocomplete rows follow the bottom border. */
export function highlightMarkdownSourceLines(lines: string[], visibleSourceRows: number): void {
	const theme = getMarkdownTheme();
	let inFence = false;
	let language: string | undefined;
	for (let i = 1; i <= visibleSourceRows && i < lines.length; i++) {
		const result = highlightMarkdownLine(lines[i] ?? "", inFence, language, theme);
		lines[i] = result.text;
		inFence = result.inFence;
		language = result.language;
	}
}

export class MarkdownEditor extends CustomEditor {
	onRequestSubmit: (() => void) | undefined;
	/** Return true only when the current input is a command Pi can execute. */
	shouldSubmitCommand: ((text: string) => boolean) | undefined;

	override handleInput(data: string): void {
		if (matchesKey(data, "shift+enter")) {
			this.onRequestSubmit?.();
			return;
		}
		if (matchesKey(data, "enter")) {
			// An open autocomplete menu owns Enter first. This includes both
			// command-name and argument/path completion; delegating preserves
			// Pi's native selection and (where applicable) submit behavior.
			if (this.capturesViewportInput || this.shouldSubmitCommand?.(this.getExpandedText())) {
				super.handleInput(data);
				return;
			}
			// Use the public editing operation so undo, paste and onChange retain
			// their native behavior, while plain Enter never submits Markdown.
			this.insertTextAtCursor("\n");
			return;
		}
		super.handleInput(data);
	}

	/** Submit only after the extension's confirmation dialog accepts. */
	confirmedSubmit(): void {
		// This is the native submit operation (private in the current typings,
		// but present at runtime). Unlike handleInput("\r"), it also submits
		// text ending in a backslash instead of turning that into a newline.
		const submit = (this as unknown as { submitValue: () => void }).submitValue;
		submit.call(this);
	}

	override render(width: number): string[] {
		const sourceLines = [...super.render(width)];
		const sourceRows = (this as unknown as { renderedVisibleLineCount?: number }).renderedVisibleLineCount
			?? Math.max(0, sourceLines.length - 2);
		highlightMarkdownSourceLines(sourceLines, sourceRows);
		return sourceLines;
	}
}
