/**
 * terminal/component.ts — 终端交互界面(overlay 组件)。
 *
 * 布局(自上而下):
 *   输出缓冲窗口(滚动回看) + 输入行(带光标) + 状态/帮助栏
 *
 * 按键:
 *   Enter          执行当前输入行
 *   ↑ / ↓          历史命令
 *   PgUp / PgDn    滚动回看输出
 *   Ctrl+C         中断前台进程组 (SIGINT)
 *   Ctrl+L         清空可见输出缓冲
 *   Esc            折叠(进程继续运行,返回 pi 会话)
 *   Ctrl+X         销毁(需再按一次确认,终止进程组并清理会话)
 *   其余可打印字符 / 粘贴文本 → 进入输入行;含换行的粘贴逐行执行
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type Component,
	type Focusable,
	type TUI,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ShellSession } from "./shell.ts";

/** 折叠 / 销毁 两种结束交互的方式。 */
export type TerminalAction = "fold" | "destroy";

/** 输出窗口行数(不含输入行与帮助栏)。 */
const OUTPUT_ROWS = 18;

export class TerminalComponent implements Component, Focusable {
	focused = true;

	private input = "";
	private cursor = 0;
	private history: string[] = [];
	private historyPos: number | null = null;
	/** 滚动偏移:0 = 贴底,>0 = 往回看。 */
	private scroll = 0;
	/** 是否处于「再按 Ctrl+X 确认销毁」状态。 */
	private confirmDestroy = false;

	constructor(
		private session: ShellSession,
		private theme: Theme,
		private tui: TUI,
		private done: (action: TerminalAction) => void,
	) {}

	// -- 渲染 ---------------------------------------------------------------

	render(width: number): string[] {
		const lines: string[] = [];

		// 输出窗口
		const view = this.session.getView(this.scroll, OUTPUT_ROWS);
		for (const raw of view) lines.push(truncateToWidth(raw, width));

		// 分隔 + 输入行(带光标标记,供 TUI 定位硬件光标 / IME)
		lines.push(this.theme.style("─".repeat(Math.max(0, Math.min(width, 80))), { fg: "muted" }));
		lines.push(this.renderPrompt(width));

		// 状态 / 帮助栏
		lines.push(this.renderStatus(width));

		return lines;
	}

	private renderPrompt(width: number): string {
		const prompt = `${this.shortCwd()} $ `;
		const avail = Math.max(8, width - visibleWidth(prompt) - 1);

		// 光标超出可视范围时,窗口右移到能容纳光标处。
		let start = 0;
		if (this.cursor > avail) start = this.cursor - avail;
		const shown = this.input.slice(start, start + avail);
		const cursorIdx = this.cursor - start;

		const head = this.theme.style(prompt, { fg: "accent", bold: true });
		const body = shown.slice(0, cursorIdx) + CURSOR_MARKER + shown.slice(cursorIdx);
		return truncateToWidth(head + body, width);
	}

	private renderStatus(width: number): string {
		if (this.confirmDestroy) {
			return truncateToWidth(
				this.theme.style(" 再按 Ctrl+X 确认销毁(终止进程) · 按 Esc 取消 ", { fg: "error", bold: true }),
				width,
			);
		}
		const st =
			this.session.status === "running"
				? this.theme.style("●运行中", { fg: "success" })
				: this.theme.style(`■已退出(${this.session.exitSignal ?? this.session.exitCode ?? "?"})`, { fg: "muted" });
		const scrollHint = this.scroll > 0 ? this.theme.style(` 回看-${this.scroll}行 `, { fg: "warning" }) : "";
		const help = this.theme.style(
			" Enter=执行 ↑↓=历史 PgUp/PgDn=滚动 Ctrl+C=中断 Ctrl+L=清屏 Esc=折叠 Ctrl+X=销毁 ",
			{ fg: "muted" },
		);
		return truncateToWidth(`${st} ${this.session.name}${scrollHint} ${help}`, width);
	}

	private shortCwd(): string {
		const home = process.env.HOME || process.env.USERPROFILE;
		let cwd = this.session.cwd;
		if (home && cwd.startsWith(home)) cwd = `~${cwd.slice(home.length)}`;
		const parts = cwd.split("/");
		return parts[parts.length - 1] || "/";
	}

	invalidate(): void {
		// 渲染不缓存,无需清理。
	}

	// -- 输入 ---------------------------------------------------------------

	handleInput(data: string): void {
		// 确认销毁状态下,只处理 Ctrl+X / Esc。
		if (this.confirmDestroy) {
			if (matchesKey(data, Key.ctrl("x"))) {
				this.done("destroy");
				return;
			}
			if (matchesKey(data, "escape")) {
				this.confirmDestroy = false;
				this.tui.requestRender();
				return;
			}
			return;
		}

		// 结束 / 控制键
		if (matchesKey(data, "escape")) {
			this.done("fold");
			return;
		}
		if (matchesKey(data, Key.ctrl("x"))) {
			this.confirmDestroy = true;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			this.session.interrupt();
			this.input = "";
			this.cursor = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("l"))) {
			this.session.clear();
			this.scroll = 0;
			this.tui.requestRender();
			return;
		}

		// 编辑键
		if (matchesKey(data, "enter")) {
			this.submit();
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.backspace();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "delete")) {
			this.deleteForward();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "left")) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			this.cursor = Math.min(this.input.length, this.cursor + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "home")) {
			this.cursor = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.cursor = this.input.length;
			this.tui.requestRender();
			return;
		}

		// 历史
		if (matchesKey(data, "up")) {
			this.historyPrev();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.historyNext();
			this.tui.requestRender();
			return;
		}

		// 滚动
		if (matchesKey(data, "pageUp")) {
			this.scroll = Math.min(Math.max(0, this.session.lines.length - OUTPUT_ROWS), this.scroll + OUTPUT_ROWS);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scroll = Math.max(0, this.scroll - OUTPUT_ROWS);
			this.tui.requestRender();
			return;
		}

		// 含换行的粘贴:逐行执行,最后一段留在输入行。
		if (/[\r\n]/.test(data)) {
			const parts = data.split(/\r?\n/);
			for (let i = 0; i < parts.length; i++) {
				if (parts[i]) this.insert(parts[i]);
				if (i < parts.length - 1) this.submit();
			}
			this.tui.requestRender();
			return;
		}

		// 可打印文本
		this.insert(data);
		this.tui.requestRender();
	}

	private insert(text: string): void {
		const clean = Array.from(text)
			.filter((ch) => {
				const c = ch.codePointAt(0) ?? 0;
				return c >= 0x20 && c !== 0x7f;
			})
			.join("");
		if (!clean) return;
		this.input = this.input.slice(0, this.cursor) + clean + this.input.slice(this.cursor);
		this.cursor += clean.length;
		this.historyPos = null;
	}

	private backspace(): void {
		if (this.cursor <= 0) return;
		const before = this.input.slice(0, this.cursor);
		const chars = Array.from(before);
		const last = chars.pop();
		const removeLen = last ? last.length : 1;
		this.input = before.slice(0, this.cursor - removeLen) + this.input.slice(this.cursor);
		this.cursor -= removeLen;
	}

	private deleteForward(): void {
		if (this.cursor >= this.input.length) return;
		const after = this.input.slice(this.cursor);
		const first = Array.from(after)[0];
		const removeLen = first ? first.length : 1;
		this.input = this.input.slice(0, this.cursor) + after.slice(removeLen);
	}

	private submit(): void {
		const cmd = this.input;
		this.input = "";
		this.cursor = 0;
		this.historyPos = null;
		this.scroll = 0;
		if (!cmd.trim()) {
			this.tui.requestRender();
			return;
		}
		if (this.history[this.history.length - 1] !== cmd) this.history.push(cmd);
		if (this.history.length > 500) this.history.shift();
		this.session.send(cmd);
	}

	private historyPrev(): void {
		if (this.history.length === 0) return;
		if (this.historyPos === null) this.historyPos = this.history.length - 1;
		else this.historyPos = Math.max(0, this.historyPos - 1);
		this.input = this.history[this.historyPos] ?? "";
		this.cursor = this.input.length;
	}

	private historyNext(): void {
		if (this.historyPos === null) return;
		this.historyPos += 1;
		if (this.historyPos >= this.history.length) {
			this.historyPos = null;
			this.input = "";
		} else {
			this.input = this.history[this.historyPos] ?? "";
		}
		this.cursor = this.input.length;
	}
}
