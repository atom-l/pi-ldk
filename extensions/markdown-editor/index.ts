import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { MarkdownEditor } from "./editor.ts";
import { isPiCommand } from "./commands.ts";

type NativeEditorFactory = ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

type PendingConfirmation = {
	editor: MarkdownEditor;
	generation: number;
	abort: AbortController;
};

export default function markdownEditorExtension(pi: ExtensionAPI): void {
	let previousFactory: NativeEditorFactory;
	let enabled = false;
	let generation = 0;
	let activeEditor: MarkdownEditor | undefined;
	let activeContext: ExtensionContext | undefined;
	let pendingConfirmation: PendingConfirmation | undefined;

	const markdownFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager): MarkdownEditor => {
		const editor = new MarkdownEditor(tui, theme, keybindings);
		editor.shouldSubmitCommand = (text) => isPiCommand(text, pi.getCommands());
		if (enabled) activeEditor = editor;
		editor.onRequestSubmit = () => {
			void requestConfirmation(editor);
		};
		return editor;
	};

	function invalidatePendingOperations(): void {
		generation++;
		pendingConfirmation?.abort.abort();
		pendingConfirmation = undefined;
		activeEditor = undefined;
	}

	function restoreNativeMode(ctx: ExtensionContext): void {
		const ownsEditorFactory = ctx.ui.getEditorComponent() === markdownFactory;
		invalidatePendingOperations();
		enabled = false;
		if (ownsEditorFactory) ctx.ui.setEditorComponent(previousFactory);
		previousFactory = undefined;
	}

	async function requestConfirmation(editor: MarkdownEditor): Promise<void> {
		const ctx = activeContext;
		if (!ctx || !enabled || activeEditor !== editor || pendingConfirmation) return;
		if (!editor.getExpandedText().trim()) return;
		const pending: PendingConfirmation = { editor, generation, abort: new AbortController() };
		pendingConfirmation = pending;
		try {
			let confirmed: boolean;
			try {
				confirmed = await ctx.ui.confirm(
					"Send Markdown message?",
					"Enter to send · Esc to return to editing",
					{ signal: pending.abort.signal },
				);
			} catch {
				// A mode switch/session shutdown can dismiss the dialog. This is an
				// expected cancellation, not a failed native submit.
				return;
			}
			if (
				confirmed && enabled && activeEditor === editor &&
				pendingConfirmation === pending && generation === pending.generation
			) {
				if (ctx.ui.getEditorComponent() !== markdownFactory) return;
				if (!editor.confirmedSubmit()) {
					// Pi transfers the expanded draft when restoring the editor factory.
					restoreNativeMode(ctx);
					ctx.ui.notify('当前 Pi 不支持 Markdown 确认发送；未发送，草稿已保留在原编辑器。', 'warning');
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Markdown submit failed: ${message}`, "error");
		} finally {
			if (pendingConfirmation === pending) pendingConfirmation = undefined;
		}
	}

	pi.registerCommand("md", {
		description: "Toggle Markdown editing mode",
		handler: async (_args, ctx) => {
			activeContext = ctx;
			if (enabled || ctx.ui.getEditorComponent() === markdownFactory) {
				restoreNativeMode(ctx);
				return;
			}
			invalidatePendingOperations();
			previousFactory = ctx.ui.getEditorComponent();
			enabled = true;
			ctx.ui.setEditorComponent(markdownFactory);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		// Every new session starts with the native editor, even if /md was on.
		restoreNativeMode(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		activeContext = ctx;
		restoreNativeMode(ctx);
	});
}
