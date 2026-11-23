import { CustomEditor, getMarkdownTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/** CSI/OSC/APC sequences, including Pi's APC cursor markers, are never source text. */
const ANSI_SEQUENCE_SOURCE = String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[_P^][^\x07\x1b]*(?:\x07|\x1b\\))`;
const MARKDOWN_TOKEN =
	/(`+[^`\r\n]*`+|!\[[^\]\r\n]*\]\([^)\r\n]+\)|\[[^\]\r\n]*\]\([^)\r\n]+\)|https?:\/\/[^\s<]+|\*\*[^*\r\n]+\*\*|__[^_\r\n]+__|^\s*(?:#{1,6}|>|```[^\r\n]*|~~~[^\r\n]*|[-+*]|\d+[.)])(?=\s|$))/g;

function ansiSequence(): RegExp {
	return new RegExp(ANSI_SEQUENCE_SOURCE, "g");
}

function colorToken(token: string): string {
	const content = token.trimStart();
	const leading = token.slice(0, token.length - content.length);
	let color = "33";
	if (content.startsWith("`")) color = "36";
	else if (content.startsWith("#")) color = "35";
	else if (content.startsWith(">")) color = "32";
	else if (/^(?:!?\[|https?:)/.test(content)) color = "34";
	return `${leading}\x1b[${color}m${content}\x1b[39m`;
}

function mapPlainSegments(line: string, map: (text: string) => string): string {
	let result = "";
	let plainStart = 0;
	const ansi = ansiSequence();
	let match: RegExpExecArray | null;
	while ((match = ansi.exec(line)) !== null) {
		result += map(line.slice(plainStart, match.index));
		result += match[0];
		plainStart = match.index + match[0].length;
	}
	return result + map(line.slice(plainStart));
}

function colorWholeText(text: string, color = "36"): string {
	return text ? `\x1b[${color}m${text}\x1b[39m` : text;
}

/** Highlight a rendered source line without modifying cursor or other control sequences. */
export function highlightMarkdownLine(line: string, inFence = false): { text: string; inFence: boolean } {
	const plain = line.replace(ansiSequence(), "");
	const fence = /^\s*(?:```|~~~)/.test(plain);
	if (inFence && !fence) return { text: mapPlainSegments(line, colorWholeText), inFence };
	if (/^\s*#{1,6}\s+/.test(plain)) {
		return { text: mapPlainSegments(line, (text) => colorWholeText(text, "35")), inFence };
	}
	return {
		text: mapPlainSegments(line, (text) => text.replace(MARKDOWN_TOKEN, colorToken)),
		inFence: fence ? !inFence : inFence,
	};
}

/** Only highlight the native source rows; autocomplete rows follow the bottom border. */
export function highlightMarkdownSourceLines(lines: string[], visibleSourceRows: number): void {
	let inFence = false;
	for (let i = 1; i <= visibleSourceRows && i < lines.length; i++) {
		const result = highlightMarkdownLine(lines[i] ?? "", inFence);
		lines[i] = result.text;
		inFence = result.inFence;
	}
}

export class MarkdownEditor extends CustomEditor {
	onRequestSubmit: (() => void) | undefined;
	private markdown: Markdown | undefined;
	private markdownText: string | undefined;

	override handleInput(data: string): void {
		if (matchesKey(data, "shift+enter")) {
			this.onRequestSubmit?.();
			return;
		}
		if (matchesKey(data, "enter")) {
			// Use the public editing operation so undo, paste and onChange retain
			// their native behavior, while plain Enter never submits.
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

	override invalidate(): void {
		this.markdown?.invalidate();
		this.markdown = undefined;
		this.markdownText = undefined;
		super.invalidate();
	}

	override render(width: number): string[] {
		const sourceLines = [...super.render(width)];
		const sourceRows = (this as unknown as { renderedVisibleLineCount?: number }).renderedVisibleLineCount
			?? Math.max(0, sourceLines.length - 2);
		highlightMarkdownSourceLines(sourceLines, sourceRows);

		const text = this.getExpandedText();
		if (!text.trim()) return sourceLines;
		if (!this.markdown || this.markdownText !== text) {
			this.markdown = new Markdown(text, 0, 0, getMarkdownTheme());
			this.markdownText = text;
		}
		const rendered = this.markdown.render(width);
		// Native source editing already reserves about 30% of the terminal.
		// Keep the complete component within a proportional total-height budget.
		const totalBudget = Math.max(7, Math.floor(this.tui.terminal.rows * 0.55));
		const previewBudget = Math.max(0, Math.min(
			Math.floor(this.tui.terminal.rows * 0.2),
			totalBudget - sourceLines.length - 1,
		));
		if (previewBudget === 0) return sourceLines;
		const visible = rendered.length > previewBudget
			? rendered.slice(0, Math.max(0, previewBudget - 1))
			: [...rendered];
		if (rendered.length > previewBudget) {
			const hidden = rendered.length - visible.length;
			visible.push(`\x1b[2m… ${hidden} more\x1b[22m`);
		}
		const divider = `\x1b[2m─ Markdown ${"─".repeat(Math.max(0, width - 11))}\x1b[22m`;
		return [...sourceLines, divider, ...visible];
	}
}
