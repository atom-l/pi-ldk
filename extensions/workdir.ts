/**
 * Session Working Directory(会话工作目录 / 工作范围)
 *
 * 会话级的"概念工作目录":声明当前会话在某个目录上工作,并引导模型把注意力聚焦在
 * 该目录之内——对其上方的父目录和同级的兄弟目录尽量不关注、不探查。
 *
 * 这是概念上的范围(scope),**不改变进程 cwd**,也**不硬性拦截**越界访问。它通过系统
 * 提示引导模型的关注范围,把当前工作目录显示在底栏,并支持随时切换 / 重置。
 *
 * ⚠️ 硬约束(不可破坏):本扩展**绝不触碰 `.pi` 目录的有效性**。工作目录是一个与宿主
 * cwd 完全正交的概念状态:它不调用 process.chdir、不写 ctx.cwd、不改 sessionManager。
 * `.pi` 目录(扩展加载、`/reload`、`/mcp-adapter` 配置等)一律锚定会话启动时的 `ctx.cwd`,
 * 不随 workdir 切换 / 恢复而改变。workDir 只流向三处:提示文本、底栏状态、本命令自身
 * 的相对路径解析。切勿让 workDir 渗入任何 `.pi` 路径或宿主 cwd 的解析。
 *
 * 命令:
 *   /workdir            (/wd)      无参数:弹出选项(切换到子目录 / 输入路径 / 重置为默认)
 *   /workdir <路径>                 直接切换到指定目录(相对路径以当前工作目录为基准)
 *
 * 新会话默认工作目录 = 会话启动目录(ctx.cwd)。切换 / 重置会持久化,resume、分支切换时恢复。
 *
 * Loaded automatically from the package's pi.extensions. After editing, run /reload in pi.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	CustomEntry,
} from "@earendil-works/pi-coding-agent";
import { statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep, dirname } from "node:path";

/** 会话条目类型(用于持久化与回放)。 */
const ENTRY_TYPE = "session-workdir-v1";

/** 持久化操作:set = 切换 / 重置工作目录(记录绝对路径)。 */
type StoreOp = { op: "wd_set"; path: string };

/** 子目录快选最多列出多少个(避免刷屏)。 */
const MAX_SUBDIRS = 40;

// ---------------------------------------------------------------------------
// 路径解析与校验
// ---------------------------------------------------------------------------

/**
 * 把用户输入解析为绝对目录:
 *   - `~` / `~/...` 展开为家目录;
 *   - 相对路径以 base(当前工作目录)为基准;
 *   - 其余按绝对路径解析。
 */
function resolveDir(raw: string, base: string): string {
	let p = raw.trim();
	if (!p) return base;
	if (p === "~") p = homedir();
	else if (p.startsWith(`~${sep}`) || p.startsWith("~/")) p = join(homedir(), p.slice(2));
	return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

/** 路径是否为已存在的目录。 */
function isDirectory(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** 列出目录下的直接子目录(隐藏目录除外),用于快选;失败返回空。 */
function listSubdirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => e.name)
			.sort()
			.slice(0, MAX_SUBDIRS);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// 工作范围提示(注入系统提示,引导模型注意力)
// ---------------------------------------------------------------------------

/**
 * 生成工作范围提示。workDir 为当前工作目录,defaultDir 为会话默认目录。
 * 核心规则:聚焦 workDir 内,父目录 / 兄弟目录尽量不关注。
 */
function scopeSection(workDir: string, defaultDir: string): string {
	const lines: string[] = [
		`当前会话的工作目录(概念上的工作范围):${workDir}`,
		``,
		`- 本会话的主体工作都发生在该目录之内:读文件、搜代码、改代码、跑命令,都优先限定在 ${workDir} 及其子目录。`,
		`- 相对路径一律以 ${workDir} 为基准解析。`,
	];
	if (workDir !== defaultDir) {
		lines.push(`- 该目录是当前聚焦的工作范围;会话默认范围是 ${defaultDir}。`);
	}
	const parent = dirname(workDir);
	if (parent && parent !== workDir) {
		lines.push(
			`- 对其上方的父目录(${parent})和同级的兄弟目录,尽量不关注:不要主动遍历、列出或读取它们。`,
		);
	}
	lines.push(
		`- 除非任务确实必须(例如依赖了外部模块 / 跨目录的接口),否则不要越出该范围;确需越界时只做最小必要的访问,完成后回到该目录之内。`,
	);
	return `<session_working_directory>\n${lines.join("\n")}\n</session_working_directory>`;
}

// ---------------------------------------------------------------------------
// 扩展
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	/** 会话默认工作目录(会话启动目录;重置目标)。仅用于提示/底栏/自身路径解析,不写 ctx.cwd。 */
	let defaultDir = "";
	/** 当前工作目录(概念范围)。与宿主 ctx.cwd / `.pi` 解析完全正交,见文件头硬约束。 */
	let workDir = "";

	// -- 状态持久化与恢复 ---------------------------------------------------

	function persist(op: StoreOp): void {
		// 结构化克隆:条目按引用持有 data,后续原地变更不能污染已记录的操作日志。
		pi.appendEntry<StoreOp>(ENTRY_TYPE, structuredClone(op));
	}

	function applyOp(data: unknown): void {
		const op = data as StoreOp | undefined;
		if (!op || typeof op !== "object") return;
		if (op.op === "wd_set" && typeof op.path === "string" && op.path) {
			workDir = op.path;
		}
	}

	/** 从会话分支重建状态:默认 = ctx.cwd,wd_set 操作依次重放。 */
	function rebuildFromSession(ctx: ExtensionContext): void {
		defaultDir = ctx.cwd;
		workDir = ctx.cwd;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom") {
				const custom = entry as CustomEntry<StoreOp>;
				if (custom.customType === ENTRY_TYPE) applyOp(custom.data);
			}
		}
	}

	// -- 底栏状态 -----------------------------------------------------------

	/** 把当前工作目录写入底栏状态位(非交互模式无底栏,静默忽略)。 */
	function updateStatus(ctx: { ui?: { setStatus?: (key: string, text: string | undefined) => void } }): void {
		try {
			ctx.ui?.setStatus?.("workdir", workDir ? `wd:${workDir}` : undefined);
		} catch {
			/* 忽略 */
		}
	}

	// -- 事件 ---------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		rebuildFromSession(ctx);
		updateStatus(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		rebuildFromSession(ctx);
		updateStatus(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		try {
			ctx?.ui?.setStatus?.("workdir", undefined);
		} catch {
			/* 忽略 */
		}
		workDir = "";
		defaultDir = "";
	});

	// -- 注入工作范围提示:引导模型聚焦当前工作目录 --------------------------

	pi.on("before_agent_start", (event, ctx) => {
		const wd = workDir || ctx.cwd;
		const def = defaultDir || ctx.cwd;
		event.systemPromptOptions.sections["session_working_directory"] = scopeSection(wd, def);
	});

	// -- 切换 / 重置 --------------------------------------------------------

	/** 切换到指定目录(解析 + 校验 + 持久化 + 更新底栏)。 */
	function setWorkDir(raw: string, ctx: ExtensionCommandContext): boolean {
		const base = workDir || ctx.cwd;
		const abs = resolveDir(raw, base);
		if (!isDirectory(abs)) {
			ctx.ui.notify(`目录不存在或不是目录:${abs}`, "warning");
			return false;
		}
		workDir = abs;
		persist({ op: "wd_set", path: abs });
		updateStatus(ctx);
		ctx.ui.notify(`工作目录已切换到:${abs}`, "info");
		return true;
	}

	/** 重置为会话默认目录(会话启动目录)。 */
	function resetWorkDir(ctx: ExtensionCommandContext): void {
		const def = defaultDir || ctx.cwd;
		workDir = def;
		persist({ op: "wd_set", path: def });
		updateStatus(ctx);
		ctx.ui.notify(`工作目录已重置为默认:${def}`, "info");
	}

	// -- /workdir 命令 ------------------------------------------------------

	async function workdirHandler(raw: string, ctx: ExtensionCommandContext): Promise<void> {
		const arg = raw.trim();
		if (arg) {
			setWorkDir(arg, ctx);
			return;
		}

		// 无参数:弹出选项(子目录快选 / 输入路径 / 重置默认)。
		const cur = workDir || ctx.cwd;
		const def = defaultDir || ctx.cwd;
		const choices: { label: string; run: () => unknown }[] = [];
		for (const d of listSubdirs(cur)) {
			choices.push({ label: `📁 ${d}${sep}`, run: () => setWorkDir(join(cur, d), ctx) });
		}
		choices.push({
			label: "✎ 输入路径…",
			run: async () => {
				const input = await ctx.ui.input(`切换工作目录(当前:${cur})`, cur);
				if (input && input.trim()) setWorkDir(input, ctx);
			},
		});
		if (cur !== def) {
			choices.push({ label: "↺ 重置为默认目录", run: () => resetWorkDir(ctx) });
		}

		const options = choices.map((c) => c.label);
		const pick = await ctx.ui.select(`工作目录(当前:${cur})`, options);
		if (!pick) return;
		const idx = options.indexOf(pick);
		if (idx >= 0) await choices[idx].run();
	}

	pi.registerCommand("workdir", {
		description:
			"切换会话的工作目录 / 工作范围:无参数弹出选项(切换子目录 / 输入路径 / 重置默认);也可 /workdir <路径> 直接指定",
		handler: workdirHandler,
	});
	pi.registerCommand("wd", {
		description: "同 /workdir",
		handler: workdirHandler,
	});
}
