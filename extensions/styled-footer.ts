/**
 * Styled Footer(美化底栏)
 *
 * 用 `ctx.ui.setFooter` 接管整个底栏,替换 pi 默认的「全 dim 三行」样式,提供有层次的
 * 富文本状态栏:
 *
 *   /workspaces/proj/api ⎇ main ▸ coding               ← 位置:full path(青)·分支(紫)·会话名(琥珀)
 *   ↑2.1M ↓45k R8.2M $1.23 ▮▮▮▮▯▯▯▯ 45%·200k   gpt-5 · high   ← 统计 + 上下文进度条 + 右对齐 model
 *   ▌agent-mode:auto  ▌wd:/workspaces/proj/api          ← 扩展状态徽章(带色条,full path)
 *
 * 数据来源(与默认底栏一致,信息不丢):
 *   - footerData.getGitBranch() / getExtensionStatuses() / getAvailableProviderCount()
 *   - ctx.model / ctx.getContextUsage() / ctx.thinkingLevel / ctx.sessionManager.getEntries()
 *
 * 纯渲染层改动:不改变任何会话状态、`.pi` 解析、进程 cwd。渲染按条目数缓存,避免每帧全量扫描。
 *
 * Loaded automatically from the package's pi.extensions. After editing, run /reload in pi.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// 数值格式化(与默认底栏一致的紧凑形式)
// ---------------------------------------------------------------------------

/** token 紧凑显示:1234 -> 1.2k,1200000 -> 1.2M。 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** thinking 档位 → 主题色 token(每档独立配色,便于视觉区分)。 */
function thinkingColor(level: string): string {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax";
		case "off":
			return "thinkingOff";
		default:
			return "thinkingText";
	}
}

/** 清洗单行状态文本:去换行 / 制表 / 控制字符,折叠空格。 */
function sanitize(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 扩展状态徽章配色
// ---------------------------------------------------------------------------

/** 依扩展 key / 值给徽章挑一个前景色 token(theme.fg 接受的 token 名)。 */
function badgeColor(key: string, text: string): string {
	const k = key.toLowerCase();
	if (k.startsWith("agent-mode") || k.startsWith("amode")) {
		const v = text.toLowerCase();
		if (v.includes("off")) return "warning";
		if (v.includes("agent") && !v.includes("auto")) return "accent";
		return "success"; // auto
	}
	if (k.startsWith("workdir") || k.startsWith("wd")) return "bashMode";
	if (k.includes("image") || k.includes("gen")) return "thinkingMax";
	if (k.includes("term")) return "syntaxVariable";
	return "syntaxKeyword";
}

// ---------------------------------------------------------------------------
// 上下文进度条
// ---------------------------------------------------------------------------

/** 10 格块状进度条 + 阈值配色(>90 红 / >70 黄 / 其余绿)。 */
function contextBar(percent: number | null): { bar: string; level: "ok" | "warn" | "err" } {
	if (percent === null) return { bar: "░".repeat(10), level: "ok" };
	const filled = Math.max(0, Math.min(10, Math.round((percent / 100) * 10)));
	const bar = "▮".repeat(filled) + "▯".repeat(10 - filled);
	const level = percent > 90 ? "err" : percent > 70 ? "warn" : "ok";
	return { bar, level };
}

// ---------------------------------------------------------------------------
// 用量统计(从会话条目累计,带缓存)
// ---------------------------------------------------------------------------

interface Stats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	cacheHit: number | undefined;
}

interface StatsCache {
	entryCount: number;
	stats: Stats;
}

function costOf(usage: { cost?: unknown }): number {
	const c = usage.cost as { total?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined;
	if (!c) return 0;
	if (typeof c.total === "number") return c.total;
	return (c.input ?? 0) + (c.output ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0);
}

function computeStats(ctx: ExtensionContext): Stats {
	const empty: Stats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHit: undefined };
	const sm = ctx.sessionManager as { getEntries?: () => unknown[] };
	if (typeof sm.getEntries !== "function") return empty;
	let cacheHit: number | undefined;
	for (const raw of sm.getEntries()) {
		const entry = raw as { type?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: unknown }; message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: unknown } } };
		let u: typeof entry.usage | undefined;
		if (entry.type === "usage" || entry.type === "branch_summary" || entry.type === "compaction") u = entry.usage;
		else if (entry.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")) u = entry.message?.usage;
		if (!u) continue;
		empty.input += u.input ?? 0;
		empty.output += u.output ?? 0;
		empty.cacheRead += u.cacheRead ?? 0;
		empty.cacheWrite += u.cacheWrite ?? 0;
		empty.cost += costOf(u);
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
			cacheHit = prompt > 0 ? ((u.cacheRead ?? 0) / prompt) * 100 : undefined;
		}
	}
	empty.cacheHit = cacheHit;
	return empty;
}

// ---------------------------------------------------------------------------
// 扩展
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	/** 最近一次事件的 ctx:底栏渲染需读 model / 用量,但 setFooter 的 factory 不带 ctx。 */
	let latestCtx: ExtensionContext | undefined;
	/** 用量缓存(按条目数),避免每帧重扫全会话。 */
	let cache: StatsCache | undefined;
	/** 是否已接管底栏(避免重复 setFooter)。 */
	let installed = false;

	function statsFor(ctx: ExtensionContext): Stats {
		const count = (ctx.sessionManager as { getEntryCount?: () => number }).getEntryCount?.() ?? 0;
		if (cache && cache.entryCount === count) return cache.stats;
		const stats = computeStats(ctx);
		cache = { entryCount: count, stats };
		return stats;
	}

	function installFooter(ctx: ExtensionContext): void {
		if (installed) return;
		const ui = ctx.ui as { setFooter?: (factory: unknown) => void };
		if (typeof ui.setFooter !== "function") return;
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		installed = true;

		ui.setFooter(
			(
				_tui: unknown,
				theme: {
					fg(color: string, text: string): string;
					bold(text: string): string;
					italic(text: string): string;
				},
				footerData: {
					getGitBranch(): string | null;
					getExtensionStatuses(): ReadonlyMap<string, string>;
					getAvailableProviderCount(): number;
				},
			) => {
				const dim = (s: string) => theme.fg("dim", s);

				// -- 第 1 行:位置(路径 · 分支 · 会话名) ------------------------
				function renderLocation(width: number): string {
					const cwd = latestCtx?.cwd ?? process.cwd();
					const parts: string[] = [theme.fg("syntaxVariable", cwd)];
					const branch = footerData.getGitBranch();
					if (branch) parts.push(theme.fg("accent", `⎇ ${branch}`));
					const name = (latestCtx?.sessionManager as { getSessionName?: () => string })?.getSessionName?.();
					if (name) parts.push(theme.fg("syntaxString", `▸ ${name}`));
					return truncateToWidth(parts.join(dim(" · ")), width, dim("…"));
				}

				// -- 第 2 行:统计 + 上下文进度条 + 右对齐 model ----------------
				function renderStats(width: number): string {
					const ctx = latestCtx;
					const s = ctx ? statsFor(ctx) : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheHit: undefined };
					const statsParts: string[] = [];
					if (s.input) statsParts.push(theme.fg("syntaxKeyword", `↑${formatTokens(s.input)}`));
					if (s.output) statsParts.push(theme.fg("bashMode", `↓${formatTokens(s.output)}`));
					if (s.cacheRead) statsParts.push(theme.fg("thinkingXhigh", `R${formatTokens(s.cacheRead)}`));
					if (s.cacheWrite) statsParts.push(theme.fg("thinkingMax", `W${formatTokens(s.cacheWrite)}`));
					if (s.cacheHit !== undefined && (s.cacheRead || s.cacheWrite)) {
						statsParts.push(theme.fg("success", `CH${s.cacheHit.toFixed(0)}%`));
					}
					if (s.cost) statsParts.push(theme.fg("warning", `$${s.cost.toFixed(2)}`));

					// 上下文进度条 + 百分比
					const cu = ctx?.getContextUsage();
					const percent = cu && cu.percent !== null && cu.percent !== undefined ? cu.percent : null;
					const window = cu?.contextWindow ?? ctx?.model?.contextWindow ?? 0;
					const { bar, level } = contextBar(percent);
					const barColor = level === "err" ? "error" : level === "warn" ? "warning" : "success";
					const pctText = percent === null ? "?" : `${Math.round(percent)}%`;
					statsParts.push(
						theme.fg(barColor, bar) +
							theme.fg(barColor, ` ${pctText}`) +
							(window ? dim(`·${formatTokens(window)}`) : ""),
					);

					const left = statsParts.join(dim(" "));

					// 右侧:model · thinking(多 provider 时前置 provider)
					const model = ctx?.model;
					let right = model ? theme.fg("thinkingMedium", model.id) : dim("no-model");
					const thinking = ctx?.thinkingLevel;
					if (model?.reasoning) {
						right += dim(" · ") + (thinking && thinking !== "off" ? theme.fg(thinkingColor(thinking), thinking) : dim("thinking off"));
					}
					if (model && footerData.getAvailableProviderCount() > 1) {
						right = dim("(") + theme.fg("muted", model.provider) + dim(") ") + right;
					}

					const leftW = visibleWidth(left);
					const rightW = visibleWidth(right);
					if (leftW + 2 + rightW <= width) {
						const pad = " ".repeat(width - leftW - rightW);
						return left + pad + right;
					}
					// 放不下:优先保留 left,right 截断
					const room = width - leftW - 2;
					if (room > 0) {
						const rt = truncateToWidth(right, room, dim("…"));
						const pad = " ".repeat(Math.max(0, width - leftW - visibleWidth(rt)));
						return left + pad + rt;
					}
					return truncateToWidth(left, width, dim("…"));
				}

				// -- 第 3 行:扩展状态徽章 ------------------------------------
				function renderBadges(width: number): string {
					const statuses = footerData.getExtensionStatuses();
					if (statuses.size === 0) return "";
					const badges = Array.from(statuses.entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => {
							const clean = sanitize(text);
							const color = badgeColor(text, clean);
							return theme.fg(color, "▌") + " " + theme.fg(color, clean);
						});
					return truncateToWidth(badges.join(dim("   ")), width, dim("…"));
				}

				return {
					render(width: number): string[] {
						const w = Math.max(1, width);
						const lines = [renderLocation(w), renderStats(w)];
						const badges = renderBadges(w);
						if (badges) lines.push(badges);
						return lines;
					},
					invalidate(): void {
						cache = undefined;
					},
					dispose(): void {
						installed = false;
					},
				};
			},
		);
	}

	// -- 事件:捕获最新 ctx(底栏要读 model/用量),并装上自定义底栏 ----------

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		cache = undefined;
		installFooter(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		latestCtx = ctx;
		cache = undefined;
	});
	pi.on("before_agent_start", (_event, ctx) => {
		latestCtx = ctx;
	});
	pi.on("model_select", (event, ctx) => {
		latestCtx = ctx;
		cache = undefined;
	});
	pi.on("session_shutdown", (_event, ctx) => {
		// 还原默认底栏,避免残留自定义组件。
		try {
			(ctx?.ui as { setFooter?: (f: undefined) => void })?.setFooter?.(undefined);
		} catch {
			/* 忽略 */
		}
		installed = false;
		latestCtx = undefined;
		cache = undefined;
	});
}
