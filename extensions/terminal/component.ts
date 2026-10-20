/**
 * terminal/component.ts — 终端交互界面(overlay 组件)。
 *
 * 布局(自上而下):
 *   输出缓冲窗口(滚动回看) + 输入行(带光标) + 状态/帮助栏
 *
 * 按键:
 *   Enter          执行当前输入行(命令会回显进输出缓冲,便于对照结果)
 *   ← / →          按码点移动光标(不拆散 emoji / 代理对)
 *   ↑ / ↓          历史命令
 *   PgUp / PgDn    滚动回看输出
 *   Ctrl+C         中断前台进程组 (SIGINT) - 注意:终端会话自身也在该进程组内,shell 可能随之退出(已知限制,不做进程组隔离)
 *   Ctrl+L         清空可见输出缓冲
 *   Esc            折叠(进程继续运行,返回 pi 会话)
 *   Ctrl+X         销毁(需再按一次确认,终止进程组并清理会话)
 *   其余可打印字符 / 粘贴文本 → 进入输入行;含换行的粘贴逐行执行
 *   未识别的控制 / 转义序列(如 Ctrl+← = \x1b[1;5D)整体忽略,不污染输入行
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

/** 输出窗口行数(不含分隔线、输入行与帮助栏)。 */
const OUTPUT_ROWS = 18;

/** 含控制字符 / 转义序列的输入(非纯可打印文本)。 */
const CONTROL_OR_ESC = /[\x00-\x1f\x7f]/;

export class TerminalComponent implements Component, Focusable {
	focused = true;

	private input = "";
	/** 光标位置(UTF-16 码元下标)。 */
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

	/** 边框线(用 borderAccent 配色,让终端面板从聊天流里凸显出来)。 */
	private border(text: string): string {
		return this.theme.style(text, { fg: "borderAccent" });
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const inner = Math.max(8, width - 2);

		// 顶边框 + 标题行(名称 + 状态)
		lines.push(this.border(`╭${"─".repeat(inner)}╮`));
		lines.push(this.renderTitle(inner));
		lines.push(this.border(`├${"─".repeat(inner)}┤`));

		// 输出窗口(带左右边框)
		for (const raw of this.session.getView(this.scroll, OUTPUT_ROWS)) {
			lines.push(this.frameRow(raw, inner));
		}

		// 输入区
		lines.push(this.border(`├${"─".repeat(inner)}┤`));
		lines.push(this.renderPrompt(inner));
		lines.push(this.renderStatus(inner));

		// 底边框
		lines.push(this.border(`╰${"─".repeat(inner)}╯`));

		return lines;
	}

	/** 把一段内容包进左右边框,内部按可视宽度补齐到 inner 列。 */
	private frameRow(content: string, inner: number): string {
		const padded = truncateToWidth(content, inner, "…", true);
		return this.border("│") + padded + this.border("│");
	}

	private renderTitle(inner: number): string {
		const st =
			this.session.status === "running"
				? this.theme.style("● 运行中", { fg: "success" })
				: this.theme.style(`■ 已退出(${this.session.exitSignal ?? this.session.exitCode ?? "?"})`, { fg: "error" });
		const mark = this.theme.style("▸ TERMINAL", { fg: "borderAccent", bold: true });
		const name = this.theme.style(`· ${this.session.name}`, { fg: "text" });
		const scroll = this.scroll > 0 ? this.theme.style(` · 回看 ${this.scroll} 行`, { fg: "warning" }) : "";
		return this.frameRow(` ${mark} ${name} ${st}${scroll} `, inner);
	}

	private renderPrompt(inner: number): string {
		const prompt = `${this.shortCwd()} $ `;
		const avail = Math.max(6, inner - visibleWidth(prompt) - 1);

		// 光标超出可视范围时,窗口右移到能容纳光标处。
		// 窗口边界按显示列宽切(CJK / emoji 每码点多列,按 UTF-16 码元切会把右框线顶出):
		// 先右移 start 保证「光标前缀」不超 avail 列,再从 start 起按列逐码点累加取 shown。
		let start = 0;
		if (this.cursor > avail) start = this.cursor - avail;
		const c0 = this.input.charCodeAt(start);
		if (start > 0 && c0 >= 0xdc00 && c0 <= 0xdfff) start -= 1; // 不切开代理对
		while (start < this.cursor && visibleWidth(this.input.slice(start, this.cursor)) > avail) {
			start += (this.input.codePointAt(start) ?? 0) > 0xffff ? 2 : 1;
		}
		let end = start;
		let cols = 0;
		while (end < this.input.length) {
			const step = (this.input.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
			const w = visibleWidth(this.input.slice(end, end + step));
			if (cols + w > avail) break;
			cols += w;
			end += step;
		}
		const shown = this.input.slice(start, end);
		const cursorIdx = this.cursor - start;

		const head = this.theme.style(prompt, { fg: "accent", bold: true });
		const body = shown.slice(0, cursorIdx) + CURSOR_MARKER + shown.slice(cursorIdx);
		// 手动补齐,避免 CURSOR_MARKER 被截断逻辑触碰。
		const pad = Math.max(0, inner - visibleWidth(prompt) - visibleWidth(shown));
		return this.border("│") + head + body + " ".repeat(pad) + this.border("│");
	}

	private renderStatus(inner: number): string {
		if (this.confirmDestroy) {
			return this.frameRow(
				this.theme.style(" ⚠ 再按 Ctrl+X 确认销毁(终止进程) · 按 Esc 取消 ", { fg: "error", bold: true }),
				inner,
			);
		}
		const help = this.theme.style(
			"Enter=执行 ←→=光标 ↑↓=历史 PgUp/PgDn=滚动 Ctrl+C=中断 Ctrl+L=清屏 Esc=折叠 Ctrl+X=销毁",
			{ fg: "muted" },
		);
		return this.frameRow(` ${help} `, inner);
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
			this.cursor = this.prevCursor(this.cursor);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			this.cursor = this.nextCursor(this.cursor);
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

		// 未识别的控制 / 转义序列(Ctrl+← = \x1b[1;5D 等):整体忽略。
		// 否则 insert 会剥掉 ESC 后把序列残片(如 "1;5D")插进输入行。
		if (CONTROL_OR_ESC.test(data)) return;

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

	/** 上一个码点起点(不拆散代理对)。 */
	private prevCursor(pos: number): number {
		if (pos <= 0) return 0;
		const before = this.input.slice(0, pos);
		const chars = Array.from(before);
		const last = chars.pop();
		return pos - (last ? last.length : 1);
	}

	/** 下一个码点终点。 */
	private nextCursor(pos: number): number {
		if (pos >= this.input.length) return this.input.length;
		const cp = Array.from(this.input.slice(pos))[0];
		return pos + (cp ? cp.length : 1);
	}

	private backspace(): void {
		if (this.cursor <= 0) return;
		const target = this.prevCursor(this.cursor);
		this.input = this.input.slice(0, target) + this.input.slice(this.cursor);
		this.cursor = target;
	}

	private deleteForward(): void {
		if (this.cursor >= this.input.length) return;
		const target = this.nextCursor(this.cursor);
		this.input = this.input.slice(0, this.cursor) + this.input.slice(target);
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

		// 先落盘上一条命令的无换行残留输出,再回显本条命令,
		// 保证「残留片段 → 命令回显 → 本条输出」的顺序正确。
		this.session.flush();
		this.session.appendLine(`${this.shortCwd()} $ ${cmd}`);
		if (!this.session.send(cmd)) {
			// 进程已退出 / stdin 不可写:给出反馈而非静默丢弃。
			this.session.appendLine(`[无法执行] 终端进程已退出,请销毁后重新打开`);
		}
		this.tui.requestRender();
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
