/**
 * terminal — 在 pi 会话里呼出一个可折叠 / 可销毁的终端。
 *
 * 命令:
 *   /term                打开(或新建)默认终端会话 "main"
 *   /term open [name]    打开(或新建)指定会话
 *   /term new <name>     新建并打开指定会话
 *   /term list           列出所有终端会话及状态
 *   /term destroy <name> 销毁会话(先 SIGTERM、宽限期后 SIGKILL 终止整棵进程树,
 *                          不留僵尸/孤儿进程)
 *   /term help           用法
 *
 * 交互(终端内):
 *   Esc    折叠:关闭终端界面,进程继续运行、输出继续累积,回到 pi 会话;
 *          再次 /term 打开会看到折叠期间的输出。
 *   Ctrl+X 销毁:先 SIGTERM、宽限期后 SIGKILL 终止整棵进程树,清理会话。
 *   其余见终端内状态栏(Enter 执行、↑↓ 历史、PgUp/PgDn 滚动、Ctrl+C 中断、Ctrl+L 清屏)。
 *   ⚠ 已知限制:Ctrl+C 对整个前台进程组发 SIGINT,终端会话自身也在该组内,
 *   shell 可能随之退出 — 不做进程组隔离。
 *
 * 进程生命周期:每个会话用独立进程组(detached)启动用户 shell,销毁/清理时
 * process.kill(-pid) 一次性结束整棵树;session_shutdown 时兜底 dispose 全部,
 * 不留僵尸 / 孤儿进程。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ShellSession } from "./shell.ts";
import { TerminalComponent, type TerminalAction } from "./component.ts";

/** name → 常驻 shell 会话。折叠时仍存活。 */
const sessions = new Map<string, ShellSession>();

/** 保留的子命令名,不能作为会话名。 */
const RESERVED = new Set(["open", "new", "list", "destroy", "kill", "help", ""]);

function parseArgs(raw: string): { cmd: string; name?: string } {
	const parts = raw.trim().split(/\s+/).filter(Boolean);
	const head = (parts[0] ?? "").toLowerCase();
	if (!head) return { cmd: "open", name: "main" };
	if (RESERVED.has(head)) {
		return { cmd: head === "kill" ? "destroy" : head, name: parts[1] };
	}
	// 首个词不是子命令 → 视为会话名直接打开。
	return { cmd: "open", name: parts[0] };
}

export default function (pi: ExtensionAPI) {
	// 会话关闭时兜底清理,保证不漏进程。
	pi.on("session_shutdown", () => {
		for (const s of sessions.values()) s.dispose();
		sessions.clear();
	});

	// /term 与 /terminal 共用同一处理逻辑。
	pi.registerCommand("term", {
		description: "呼出一个可折叠/销毁的终端 (term [open|new|list|destroy|kill|help] [name])",
		handler: termHandler,
	});
	pi.registerCommand("terminal", {
		description: "同 /term:呼出可折叠/销毁的终端",
		handler: termHandler,
	});

	async function termHandler(raw: string, ctx: ExtensionCommandContext): Promise<void> {
			const { cmd, name } = parseArgs(raw);

			switch (cmd) {
				case "help":
					ctx.ui.notify("term / term open [name] / term new <name> / term list / term destroy <name>", "info");
					return;

				case "list": {
					if (sessions.size === 0) {
						ctx.ui.notify("暂无终端会话", "info");
						return;
					}
					const lines = [...sessions.values()].map(
						(s) =>
							`${s.name}  ${s.status}${s.status === "running" ? "" : `(${s.exitSignal ?? s.exitCode ?? "?"})`}  pid=${s.pid ?? "?"}  ${s.lines.length} 行`,
					);
					ctx.ui.notify(`终端会话(${sessions.size}):\n${lines.join("\n")}`, "info");
					return;
				}

				case "destroy": {
					const target = name ?? (await pickSession(ctx, "销毁哪个终端?"));
					if (!target) return;
					const s = sessions.get(target);
					if (!s) {
						ctx.ui.notify(`没有名为 "${target}" 的终端会话`, "warning");
						return;
					}
					if (!(await ctx.ui.confirm("销毁终端", `终止进程(pid=${s.pid ?? "?"})并清理会话 "${target}"?`))) return;
					// 等进程真正退出后再从表里移除,否则 ≤2s 宽限窗口内同名会话会"不可见"
					// (再次 /term <name> 会误建第二个 shell)。
					s.disposeGracefully(() => sessions.delete(target));
					ctx.ui.notify(`终端 "${target}" 已销毁`, "info");
					return;
				}

				case "new": {
					if (!name || RESERVED.has(name.toLowerCase())) {
						ctx.ui.notify("请指定一个非保留字的会话名,例如 /term new dev", "warning");
						return;
					}
					if (sessions.has(name)) {
						ctx.ui.notify(`会话 "${name}" 已存在,直接打开`, "info");
					}
					await openTerminal(ctx, name);
					return;
				}

				case "open":
				default: {
					await openTerminal(ctx, name ?? "main");
					return;
				}
			}
	}

	async function pickSession(ctx: ExtensionCommandContext, title: string): Promise<string | undefined> {
		const names = [...sessions.keys()];
		if (names.length === 0) {
			ctx.ui.notify("暂无终端会话", "info");
			return undefined;
		}
		if (names.length === 1) return names[0];
		return ctx.ui.select(title, names);
	}

	async function openTerminal(ctx: ExtensionCommandContext, name: string): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("终端仅在交互(tui)模式可用", "warning");
			return;
		}

		let session = sessions.get(name);
		if (!session) {
			session = new ShellSession({ name, cwd: ctx.cwd });
			sessions.set(name, session);
		}
		const active = session;

		// 呼出终端:接管交互区,直到组件调用 done(fold | destroy)。
		const action = await ctx.ui.custom<TerminalAction | undefined>((tui, theme, _kb, done) => {
			// 有新输出时触发重绘(仅在终端可见期间)。
			active.onOutput = () => tui.requestRender();
			return new TerminalComponent(active, theme, tui, (a) => done(a));
		});

		// 关闭界面:停止重绘回调(进程与缓冲继续)。
		active.onOutput = null;

		if (action === "destroy") {
			// 委托 disposeGracefully 的完成回调移出表项(进程退出后),避免异步窗口内重名会话不可见。
			active.disposeGracefully(() => sessions.delete(active.name));
			ctx.ui.notify(`终端 "${active.name}" 已销毁(进程终止中)`, "info");
		} else {
			// fold 或直接关闭:进程继续运行。
			ctx.ui.notify(`终端 "${active.name}" 已折叠,进程继续运行。再次 /term ${active.name === "main" ? "" : active.name}返回。`, "info");
		}
	}
}
