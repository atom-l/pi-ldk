/**
 * session-agents — 角色 agent + 子会话工作台 + 经验记忆 的 pi 扩展。
 *
 * 架构(任务分发不直接落到 agent 上):
 *
 *   1. 角色 agent(工具 agent_*):一个"自带固定上下文的角色",
 *      有专属的知识 / 看待问题的角度 / 合适的底层模型。角色本身不直接接任务。
 *   2. 子会话(工具 subsession_*):任务上下文先指派进子会话的上下文空间;
 *      子会话是一张"公共桌面",为它指派若干角色 agent,agent 们在桌面
 *      (desk:发现/决策/异常/待决)与工作日志上相互交流、协作完成任务。
 *      完成时向调用模型返回两部分:【结果】与【额外信息】。
 *   3. 经验记忆(工具 insight_*):结果与额外信息沉淀为跨会话的记忆记录,
 *      提供类 RAG 的快速召回 / 回溯(BM25,无模型调用),并在后续任务开始时
 *      主动把相关经验作为"启发提示"注入系统提示。
 *
 * 生命周期:角色与子会话的生命周期等于会话(内存态 + custom entry 持久化,
 * resume / 分支切换后恢复);经验记忆存放在 agent 目录下的 JSONL,跨会话存活。
 *
 * 本扩展是 ldk 包(pi-ldk)的一部分,入口由 package.json 的 pi.extensions 声明。
 */

import { join } from "node:path";
import type {
	AgentToolResult,
	CustomEntry,
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Message, Model, Tool, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { InsightStore, INSIGHT_KINDS, tokenize, type InsightKind, type InsightRecord } from "./insights.ts";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 会话文件中 custom entry 的 customType(用于恢复角色与子会话状态)。 */
const ENTRY_TYPE = "session-agents-v2";
const DEFAULT_MAX_TURNS = 8;
const MAX_TURNS_CAP = 24;
const MAX_RESULT_CHARS = 48_000;
const MAX_BLOCK_CHARS = 32_000;
const MAX_TURN_LOG = 80;
const TURN_LOG_KEEP = 60;
const MAX_DESK_ENTRIES = 24;
const MAX_MODEL_LISTING = 120;
/** 工作日志摘要里每条贡献的字符上限。 */
const LOG_ENTRY_CHARS = 1_500;
/** 桌面每条记录的字符上限。 */
const DESK_ENTRY_CHARS = 400;

const DESK_SECTIONS = ["findings", "decisions", "issues", "open", "artifacts", "notes"] as const;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface RoleConfig {
	name: string;
	description: string;
	/** "provider/model-id" */
	model: string;
	/** 角色的固定上下文:知识、视角、行为准则。 */
	systemPrompt: string;
	/** 可调用的会话工具;空 = 仅能使用子会话桌面工具。 */
	tools: string[];
	maxTurns: number;
}

interface RoleState {
	config: RoleConfig;
	/** 补充注入的持久上下文。 */
	contexts: string[];
	runs: number;
	usage: Usage;
	createdAt: number;
	updatedAt: number;
}

interface Assignment {
	agent: string;
	focus?: string;
	lead?: boolean;
}

interface Desk {
	findings: string[];
	decisions: string[];
	issues: string[];
	open: string[];
	artifacts: string[];
	notes: string[];
}

interface LogEntry {
	agent: string;
	focus?: string;
	instruction: string;
	contribution: string;
	turns: number;
	toolCalls: number;
	usage: Usage;
	timestamp: number;
}

interface SubSessionState {
	name: string;
	title: string;
	/** 任务目标与验收标准。 */
	task: string;
	synthesisModel?: string;
	/** 指派进子会话上下文空间的任务上下文。 */
	context: string[];
	desk: Desk;
	assignments: Assignment[];
	log: LogEntry[];
	rounds: number;
	status: "open" | "done";
	result?: string;
	extras?: string;
	usage: Usage;
	createdAt: number;
	updatedAt: number;
}

type StoreOp =
	| { op: "role_create"; role: RoleState }
	| { op: "role_update"; name: string; patch: Partial<RoleConfig>; appendContext?: string }
	| { op: "role_stats"; name: string; runs: number; usage: Usage }
	| { op: "role_stats"; name: string; runs: number; usage: Usage }
	| { op: "role_discard"; name: string }
	| { op: "role_discard_all" }
	| { op: "sub_create"; sub: SubSessionState }
	| { op: "sub_run"; name: string; log: LogEntry[]; desk: Desk; rounds: number; usage: Usage }
	| { op: "sub_finish"; name: string; result: string; extras: string; desk: Desk; usage: Usage }
	| { op: "sub_desk"; name: string; desk: Desk }
	| { op: "sub_context"; name: string; context: string }
	| { op: "sub_assign"; name: string; assignments: Assignment[] }
	| { op: "sub_discard"; name: string }
	| { op: "sub_discard_all" };

interface ToolDetails {
	action: string;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 小工具函数
// ---------------------------------------------------------------------------

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(acc: Usage, add: Usage | undefined): void {
	if (!add) return;
	acc.input += add.input ?? 0;
	acc.output += add.output ?? 0;
	acc.cacheRead += add.cacheRead ?? 0;
	acc.cacheWrite += add.cacheWrite ?? 0;
	acc.totalTokens += add.totalTokens ?? 0;
	if (add.cost) {
		acc.cost.input += add.cost.input ?? 0;
		acc.cost.output += add.cost.output ?? 0;
		acc.cost.cacheRead += add.cost.cacheRead ?? 0;
		acc.cost.cacheWrite += add.cost.cacheWrite ?? 0;
		acc.cost.total += add.cost.total ?? 0;
	}
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function oneLine(text: string, max: number): string {
	return truncate(text.replace(/\s+/g, " ").trim(), max);
}

function truncateBlocks(content: ToolResultMessage["content"]): ToolResultMessage["content"] {
	return content.map((block) => (block.type === "text" ? { ...block, text: truncate(block.text, MAX_BLOCK_CHARS) } : block));
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function formatUsage(usage: Usage): string {
	return `↑${usage.input} ↓${usage.output} R${usage.cacheRead} W${usage.cacheWrite} $${usage.cost.total.toFixed(4)}`;
}

function emptyDesk(): Desk {
	return { findings: [], decisions: [], issues: [], open: [], artifacts: [], notes: [] };
}

function pushBounded(list: string[], value: string, max: number): void {
	list.push(value);
	if (list.length > max) list.splice(0, list.length - max);
}

function appendLog(sub: SubSessionState, entry: LogEntry): void {
	sub.log.push(entry);
	if (sub.log.length > MAX_TURN_LOG) sub.log.splice(0, sub.log.length - TURN_LOG_KEEP);
}

function renderDesk(desk: Desk, compact = true): string {
	const lines: string[] = [];
	for (const section of DESK_SECTIONS) {
		const items = desk[section];
		if (items.length === 0) continue;
		lines.push(`${section}:`);
		for (const item of items.slice(compact ? -8 : -MAX_DESK_ENTRIES)) {
			lines.push(`  - ${oneLine(item, DESK_ENTRY_CHARS)}`);
		}
	}
	return lines.length ? lines.join("\n") : "(empty)";
}

function renderLogDigest(sub: SubSessionState, keep = 8): string {
	const entries = sub.log.slice(-keep);
	if (entries.length === 0) return "(no work logged yet)";
	return entries
		.map(
			(entry) =>
				`[${entry.agent}${entry.focus ? ` · ${entry.focus}` : ""}] ${oneLine(entry.instruction, 200)}\n→ ${oneLine(entry.contribution, LOG_ENTRY_CHARS)}`,
		)
		.join("\n\n");
}

function renderAssignments(sub: SubSessionState): string {
	if (sub.assignments.length === 0) return "(no agents assigned)";
	return sub.assignments
		.map((a) => `${a.agent}${a.lead ? " (lead)" : ""}${a.focus ? ` — ${a.focus}` : ""}`)
		.join("; ");
}

function ok(content: string, details: ToolDetails, usage?: Usage): AgentToolResult<ToolDetails> {
	return { content: [{ type: "text", text: content }], details, ...(usage ? { usage } : {}) };
}

function fail(message: string, details: ToolDetails): AgentToolResult<ToolDetails> {
	return { content: [{ type: "text", text: message }], details: { ...details, error: message }, isError: true };
}

// ---------------------------------------------------------------------------
// 扩展
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const roles = new Map<string, RoleState>();
	const subs = new Map<string, SubSessionState>();
	const locks = new Map<string, Promise<void>>();
	const store = new InsightStore(join(getAgentDir(), "session-agents", "insights.jsonl"));
	let storeLoaded = false;

	function ensureStore(): void {
		if (!storeLoaded) {
			store.load();
			storeLoaded = true;
		}
	}

	// -- 状态持久化与恢复 ---------------------------------------------------

	function persist(op: StoreOp): void {
		// 结构化克隆:session 条目按引用持有 data,后续原地变更不能污染已记录的操作日志。
		pi.appendEntry<StoreOp>(ENTRY_TYPE, structuredClone(op));
	}

	function applyOp(data: unknown): void {
		const op = data as StoreOp | undefined;
		if (!op || typeof op !== "object" || typeof op.op !== "string") return;
		switch (op.op) {
			case "role_create": {
				const role = op.role;
				if (role?.config?.name) {
					roles.set(role.config.name, {
						config: role.config,
						contexts: role.contexts ?? [],
						runs: role.runs ?? 0,
						usage: role.usage ?? emptyUsage(),
						createdAt: role.createdAt ?? Date.now(),
						updatedAt: role.updatedAt ?? Date.now(),
					});
				}
				break;
			}
			case "role_update": {
				const role = roles.get(op.name);
				if (role) {
					role.config = { ...role.config, ...op.patch, name: role.config.name };
					if (op.appendContext) role.contexts.push(op.appendContext);
				}
				break;
			}
			case "role_stats": {
				const role = roles.get(op.name);
				if (role) {
					role.runs = op.runs;
					role.usage = op.usage;
				}
				break;
			}
			case "role_stats": {
				const role = roles.get(op.name);
				if (role) {
					role.runs = op.runs ?? role.runs;
					role.usage = op.usage ?? role.usage;
				}
				break;
			}
			case "role_discard":
				roles.delete(op.name);
				break;
			case "role_discard_all":
				roles.clear();
				break;
			case "sub_create": {
				const sub = op.sub;
				if (sub?.name) {
					subs.set(sub.name, {
						...sub,
						context: sub.context ?? [],
						desk: { ...emptyDesk(), ...(sub.desk ?? {}) },
						assignments: sub.assignments ?? [],
						log: sub.log ?? [],
					});
				}
				break;
			}
			case "sub_run": {
				const sub = subs.get(op.name);
				if (sub) {
					for (const entry of op.log ?? []) appendLog(sub, entry);
					sub.desk = { ...emptyDesk(), ...(op.desk ?? {}) };
					sub.rounds = op.rounds ?? sub.rounds + 1;
					addUsage(sub.usage, op.usage);
					sub.updatedAt = Date.now();
				}
				break;
			}
			case "sub_finish": {
				const sub = subs.get(op.name);
				if (sub) {
					sub.status = "done";
					sub.result = op.result;
					sub.extras = op.extras;
					sub.desk = { ...emptyDesk(), ...(op.desk ?? {}) };
					addUsage(sub.usage, op.usage);
					sub.updatedAt = Date.now();
				}
				break;
			}
			case "sub_desk": {
				const sub = subs.get(op.name);
				if (sub) {
					sub.desk = { ...emptyDesk(), ...(op.desk ?? {}) };
					sub.updatedAt = Date.now();
				}
				break;
			}
			case "sub_context": {
				const sub = subs.get(op.name);
				if (sub) sub.context.push(op.context);
				break;
			}
			case "sub_assign": {
				const sub = subs.get(op.name);
				if (sub) sub.assignments = op.assignments ?? sub.assignments;
				break;
			}
			case "sub_discard":
				subs.delete(op.name);
				break;
			case "sub_discard_all":
				subs.clear();
				break;
		}
	}

	function rebuildFromSession(ctx: ExtensionContext): void {
		roles.clear();
		subs.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom") {
				const custom = entry as CustomEntry<StoreOp>;
				if (custom.customType === ENTRY_TYPE) applyOp(custom.data);
			}
		}
	}

	pi.on("session_start", (_event, ctx) => {
		rebuildFromSession(ctx);
		ensureStore();
	});
	pi.on("session_tree", (_event, ctx) => {
		rebuildFromSession(ctx);
	});
	pi.on("session_shutdown", () => {
		roles.clear();
		subs.clear();
		locks.clear();
	});

	// -- 主动提供启发:任务开始时自动召回相关经验 ----------------------------

	pi.on("before_agent_start", (event, ctx) => {
		ensureStore();
		if (store.size === 0) return;
		const prompt = event.prompt ?? "";
		if (tokenize(prompt).length < 3) return;
		const hits = store.search(prompt, { limit: 3, cwd: ctx.cwd, minScore: 2 });
		if (hits.length === 0) return;
		const lines = hits
			.map(
				(hit, index) =>
					`${index + 1}. [${hit.record.kind}] (${oneLine(hit.record.title || hit.record.source, 60)}) ${oneLine(hit.record.text, 220)}`,
			)
			.join("\n");
		event.systemPromptOptions.sections["session_agents_experience"] =
			`<session_agents_experience>\n` +
			`以下经验由历史子会话沉淀,按与当前输入的相关度自动召回。仅在确实相关时参考,不相关请忽略;\n` +
			`需要更多背景或想精确检索时调用 insight_recall。\n${lines}\n</session_agents_experience>`;
	});

	// -- 模型 / 工具解析 -----------------------------------------------------

	function resolveModel(
		ctx: ExtensionContext,
		spec: string,
	): { model: Model<Api>; error?: undefined } | { model?: undefined; error: string } {
		const wanted = spec.trim();
		if (!wanted) {
			if (ctx.model) return { model: ctx.model };
			return { error: 'No active session model. Pass `model` as "provider/model-id" (see agent_list).' };
		}
		const slash = wanted.indexOf("/");
		if (slash > 0) {
			const model = ctx.modelRegistry.find(wanted.slice(0, slash), wanted.slice(slash + 1));
			if (model) return { model };
			return { error: `Model "${wanted}" not found. Use agent_list to see available "provider/model-id" values.` };
		}
		const matches = ctx.modelRegistry.getAvailable().filter((m) => m.id === wanted || m.name === wanted);
		if (matches.length === 1) return { model: matches[0] };
		if (matches.length > 1) {
			return {
				error: `Model "${wanted}" is ambiguous: ${matches.map((m) => `${m.provider}/${m.id}`).join(", ")}. Use "provider/model-id".`,
			};
		}
		return { error: `Model "${wanted}" not found. Use agent_list to see available "provider/model-id" values.` };
	}

	function formatModelList(ctx: ExtensionContext): string[] {
		return ctx.modelRegistry
			.getAvailable()
			.slice(0, MAX_MODEL_LISTING)
			.map((m) => `${m.provider}/${m.id}`);
	}

	function resolveTools(ctx: ExtensionToolContext, names: string[]): { tools: Tool[]; error?: string } {
		const callable = new Map(ctx.tools.map((tool) => [tool.name, tool]));
		const missing = names.filter((name) => !callable.has(name));
		if (missing.length > 0) {
			return {
				tools: [],
				error: `Unknown or non-callable tool(s): ${missing.join(", ")}. Callable tools: ${[...callable.keys()].join(", ")}`,
			};
		}
		const tools: Tool[] = [];
		for (const name of names) {
			const tool = callable.get(name);
			if (tool) tools.push({ name: tool.name, description: tool.description, parameters: tool.parameters });
		}
		return { tools };
	}

	// -- 互斥锁 --------------------------------------------------------------

	async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
		const previous = locks.get(name) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const chain = previous.then(() => gate);
		locks.set(name, chain);
		await previous;
		try {
			return await fn();
		} finally {
			release();
			if (locks.get(name) === chain) locks.delete(name);
		}
	}

	// -- agent 轮次执行(内部原语,子会话协作使用) ----------------------------

	interface TurnOptions {
		model: Model<Api>;
		systemPrompt: string;
		instruction: string;
		toolNames: string[];
		maxTurns: number;
	}

	interface TurnResult {
		text: string;
		usage: Usage;
		turns: number;
		toolCalls: number;
		stopReason: string;
		errorMessage?: string;
	}

	async function runTurn(
		opts: TurnOptions,
		ctx: ExtensionToolContext,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: AgentToolResult<ToolDetails>) => void) | undefined,
		label: string,
	): Promise<TurnResult> {
		const usage = emptyUsage();
		const { tools: toolDefs, error: toolError } = resolveTools(ctx, opts.toolNames);
		if (toolError) {
			return { text: "", usage, turns: 0, toolCalls: 0, stopReason: "error", errorMessage: toolError };
		}
		const allowed = new Set(toolDefs.map((tool) => tool.name));
		const messages: Message[] = [{ role: "user", content: opts.instruction, timestamp: Date.now() }];
		let answer = "";
		let stopReason = "stop";
		let errorMessage: string | undefined;
		let turns = 0;
		let toolCalls = 0;

		for (let turn = 1; turn <= opts.maxTurns; turn++) {
			turns = turn;
			let response: AssistantMessage;
			try {
				response = await ctx.modelRegistry.complete(
					opts.model,
					{ systemPrompt: opts.systemPrompt, messages, tools: toolDefs },
					{ signal },
				);
			} catch (error) {
				stopReason = "error";
				errorMessage = error instanceof Error ? error.message : String(error);
				break;
			}
			messages.push(response);
			addUsage(usage, response.usage);

			const calls = response.content.filter((block) => block.type === "toolCall");
			const wantsTools = response.stopReason === "toolUse" && calls.length > 0 && toolDefs.length > 0;
			if (!wantsTools) {
				answer = textOf(response);
				stopReason = response.stopReason;
				errorMessage = response.errorMessage;
				break;
			}
			if (turn === opts.maxTurns) {
				answer = `${textOf(response)}\n\n[reached maxTurns=${opts.maxTurns} before a final answer]`;
				stopReason = "maxTurns";
				break;
			}
			for (const call of calls) {
				toolCalls += 1;
				onUpdate?.({
					content: [{ type: "text", text: `[${label}] turn ${turn}/${opts.maxTurns} · ${call.name}` }],
					details: { action: "run" },
				});
				let resultMessage: ToolResultMessage;
				if (!allowed.has(call.name)) {
					resultMessage = {
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: [{ type: "text", text: `Tool "${call.name}" is not available to this agent.` }],
						isError: true,
						timestamp: Date.now(),
					};
				} else {
					const outcome = await ctx.executeTool(call.name, call.arguments, { signal });
					resultMessage = {
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: truncateBlocks(outcome.result.content),
						isError: outcome.isError,
						timestamp: Date.now(),
					};
				}
				messages.push(resultMessage);
			}
		}
		return { text: answer, usage, turns, toolCalls, stopReason, errorMessage };
	}

	/** 角色 agent 的模型:角色配置优先,缺省回退会话模型。 */
	function optsModel(ctx: ExtensionToolContext, spec?: string): Model<Api> {
		const resolved = resolveModel(ctx, spec ?? "");
		if (resolved.model) return resolved.model;
		if (ctx.model) return ctx.model;
		throw new Error(resolved.error ?? "no model available");
	}

	// -- 内部工具:公共桌面写入(仅子会话内的 agent 使用) --------------------

	pi.registerTool({
		name: "desk_update",
		label: "Desk update",
		description:
			"Write to a sub-session's shared desk so collaborating agents see each other's findings, decisions, anomalies and open questions. Called by agents working inside a sub-session.",
		exposure: "deferred",
		parameters: Type.Object({
			subsession: Type.String({ description: "Name of the sub-session whose desk to update." }),
			add: Type.Object({
				findings: Type.Optional(Type.Array(Type.String(), { description: "Facts discovered." })),
				decisions: Type.Optional(Type.Array(Type.String(), { description: "Decisions made and why." })),
				issues: Type.Optional(Type.Array(Type.String(), { description: "Anomalies, errors, blockers hit." })),
				open: Type.Optional(Type.Array(Type.String(), { description: "Open questions / TODOs." })),
				artifacts: Type.Optional(Type.Array(Type.String(), { description: "Produced outputs (paths, snippets)." })),
				notes: Type.Optional(Type.Array(Type.String(), { description: "Free-form notes." })),
			}),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			const sub = subs.get(params.subsession.trim());
			if (!sub) {
				return fail(`No sub-session named "${params.subsession}". Existing: ${[...subs.keys()].join(", ") || "(none)"}`, {
					action: "desk_update",
				});
			}
			const added: string[] = [];
			for (const section of DESK_SECTIONS) {
				for (const value of params.add[section] ?? []) {
					if (typeof value === "string" && value.trim()) {
						pushBounded(sub.desk[section], value.trim(), MAX_DESK_ENTRIES);
						added.push(section);
					}
				}
			}
			sub.updatedAt = Date.now();
			persist({ op: "sub_desk", name: sub.name, desk: sub.desk });
			return ok(`Desk updated (+${added.length} entries). Desk now:\n${renderDesk(sub.desk)}`, {
				action: "desk_update",
				subsession: sub.name,
				added,
			});
		},
	});

	// -- 角色 agent 工具 -----------------------------------------------------

	const roleNamespace = {
		name: "session-agents",
		description: "Roles, sub-session workspaces, and recallable experience memory for splitting large tasks.",
		instructions:
			"Workflow: define reusable roles with agent_create; create a sub-session for the task with subsession_create (task context lives there, not in the agents); assign roles; collaborate with subsession_run; collect {result, extras} with subsession_finish. Recall past experience with insight_recall — relevant insights are also injected automatically at the start of a task.",
	};

	pi.registerTool({
		name: "agent_create",
		label: "Role: create",
		namespace: roleNamespace,
		promptSnippet: "agent_*/subsession_*/insight_*: split large tasks across role agents in sub-session workspaces",
		promptGuidelines: [
			"Split large tasks by creating a sub-session (subsession_create) whose context space holds the task context, then assign role agents to it — do not dispatch tasks straight to agents.",
			"Roles carry fixed context (knowledge, perspective) and a chosen model; reuse roles across sub-sessions and discard what is no longer needed.",
			"When a sub-session finishes, keep both the result and the extra info; recall them later with insight_recall when related work comes up.",
		],
		description: `Create a reusable role agent: a persona with its own fixed context (knowledge, viewpoint, working style) and its own underlying model. Roles do not receive tasks directly — assign them to a sub-session (subsession_create / subsession_run), where they collaborate on a shared desk. Give each role a narrow, opinionated system prompt and a model that fits its job (cheap fast models for recon, strong models for judgment).`,
		parameters: Type.Object({
			name: Type.String({ description: 'Unique role name, e.g. "explorer", "reviewer", "architect".' }),
			description: Type.String({ description: "One-line description of the role's purpose and angle." }),
			systemPrompt: Type.String({
				description: "The role's fixed context: expertise, perspective, working style, output contract. Becomes the role's system prompt in every sub-session turn.",
			}),
			model: Type.Optional(
				Type.String({ description: 'Model "provider/model-id" for this role (see agent_list). Omit for the session model.' }),
			),
			context: Type.Optional(Type.String({ description: "Extra fixed context for the role (reference material, conventions)." })),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description: "Session tools the role may call (e.g. read, grep, bash). Omit or [] for a reasoning-only role; the sub-session desk tool is always available inside sub-sessions.",
				}),
			),
			maxTurns: Type.Optional(Type.Number({ description: `Max model turns per work round (default ${DEFAULT_MAX_TURNS}, cap ${MAX_TURNS_CAP}).` })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const name = params.name.trim();
			if (!name) return fail("agent_create: `name` must not be empty.", { action: "agent_create" });
			if (roles.has(name)) {
				return fail(`Role "${name}" already exists. Use agent_update to change it or pick another name.`, { action: "agent_create" });
			}
			const resolved = resolveModel(ctx, params.model ?? "");
			if (!resolved.model) return fail(resolved.error ?? "model resolution failed", { action: "agent_create" });
			const toolNames = (params.tools ?? []).map((tool) => tool.trim()).filter(Boolean);
			const { error: toolError } = resolveTools(ctx, toolNames);
			if (toolError) return fail(toolError, { action: "agent_create" });
			const now = Date.now();
			const role: RoleState = {
				config: {
					name,
					description: params.description.trim(),
					model: `${resolved.model.provider}/${resolved.model.id}`,
					systemPrompt: params.systemPrompt,
					tools: toolNames,
					maxTurns: Math.max(1, Math.min(MAX_TURNS_CAP, Math.round(params.maxTurns ?? DEFAULT_MAX_TURNS))),
				},
				contexts: params.context?.trim() ? [params.context.trim()] : [],
				runs: 0,
				usage: emptyUsage(),
				createdAt: now,
				updatedAt: now,
			};
			roles.set(name, role);
			persist({ op: "role_create", role });
			return ok(
				`Created role "${name}" (model ${role.config.model}, tools: ${toolNames.join(", ") || "none"}, maxTurns ${role.config.maxTurns}). Assign it to a sub-session to give it work.`,
				{ action: "agent_create", role: summarizeRole(role) },
			);
		},
	});

	pi.registerTool({
		name: "agent_update",
		label: "Role: update",
		namespace: roleNamespace,
		description: `Change a role agent: model, system prompt (fixed context), tool access, maxTurns, or append additional fixed context. Only the fields you pass change.`,
		parameters: Type.Object({
			name: Type.String({ description: "Existing role name." }),
			description: Type.Optional(Type.String({ description: "New one-line description." })),
			model: Type.Optional(Type.String({ description: 'New model "provider/model-id".' })),
			systemPrompt: Type.Optional(Type.String({ description: "Replacement fixed context / system prompt." })),
			appendContext: Type.Optional(Type.String({ description: "Additional fixed context appended to the role." })),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Replacement tool list; [] removes tool access." })),
			maxTurns: Type.Optional(Type.Number({ description: "Replacement maxTurns." })),
		}),
		annotations: { readOnlyHint: false, idempotentHint: true },
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const role = roles.get(params.name.trim());
			if (!role) {
				return fail(`No role named "${params.name}". Existing: ${[...roles.keys()].join(", ") || "(none)"}`, { action: "agent_update" });
			}
			const patch: Partial<RoleConfig> = {};
			if (params.description !== undefined) patch.description = params.description.trim();
			if (params.systemPrompt !== undefined) patch.systemPrompt = params.systemPrompt;
			if (params.tools !== undefined) {
				const toolNames = params.tools.map((tool) => tool.trim()).filter(Boolean);
				const { error: toolError } = resolveTools(ctx, toolNames);
				if (toolError) return fail(toolError, { action: "agent_update" });
				patch.tools = toolNames;
			}
			if (params.maxTurns !== undefined) patch.maxTurns = Math.max(1, Math.min(MAX_TURNS_CAP, Math.round(params.maxTurns)));
			if (params.model !== undefined) {
				const resolved = resolveModel(ctx, params.model);
				if (!resolved.model) return fail(resolved.error ?? "model resolution failed", { action: "agent_update" });
				patch.model = `${resolved.model.provider}/${resolved.model.id}`;
			}
			role.config = { ...role.config, ...patch, name: role.config.name };
			if (params.appendContext?.trim()) role.contexts.push(params.appendContext.trim());
			role.updatedAt = Date.now();
			persist({ op: "role_update", name: role.config.name, patch, appendContext: params.appendContext?.trim() || undefined });
			return ok(`Updated role "${role.config.name}". Now: model ${role.config.model}, tools: ${role.config.tools.join(", ") || "none"}, maxTurns ${role.config.maxTurns}.`, {
				action: "agent_update",
				role: summarizeRole(role),
			});
		},
	});

	pi.registerTool({
		name: "agent_list",
		label: "Role: list",
		namespace: roleNamespace,
		description: `List role agents and the models available for choosing a role's model. Call before agent_create when unsure which "provider/model-id" to pick.`,
		parameters: Type.Object({
			includeModels: Type.Optional(Type.Boolean({ description: "Include available models. Default true." })),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false },
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const includeModels = params.includeModels !== false;
			const roleSummaries = [...roles.values()].map(summarizeRole);
			const subSummaries = [...subs.values()].map(summarizeSub);
			const models = includeModels ? formatModelList(ctx) : [];
			const lines: string[] = [];
			lines.push(`Roles: ${roles.size}`);
			for (const role of roles.values()) {
				lines.push(
					`  - ${role.config.name} · model ${role.config.model} · tools: ${role.config.tools.join(", ") || "none"} · maxTurns ${role.config.maxTurns} · ${formatUsage(role.usage)}`,
				);
				lines.push(`      ${role.config.description}`);
			}
			lines.push("");
			lines.push(`Sub-sessions: ${subs.size}`);
			for (const sub of subs.values()) {
				lines.push(
					`  - ${sub.name} [${sub.status}] ${sub.title} · rounds ${sub.rounds} · agents: ${sub.assignments.map((a) => a.agent).join(", ") || "(none)"} · ${formatUsage(sub.usage)}`,
				);
			}
			if (includeModels) {
				lines.push("");
				lines.push(`Available models ("provider/model-id", showing ${models.length}):`);
				for (const model of models) lines.push(`  ${model}`);
				if (ctx.model) lines.push(`Session model: ${ctx.model.provider}/${ctx.model.id} (default for new roles)`);
			}
			return ok(lines.join("\n"), { action: "agent_list", roles: roleSummaries, subsessions: subSummaries, ...(includeModels ? { models } : {}) });
		},
	});

	pi.registerTool({
		name: "agent_discard",
		label: "Role: discard",
		namespace: roleNamespace,
		description: `Discard role agents that are no longer needed: one by name, or all with all=true. Roles otherwise live until the end of the session.`,
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Role name to discard." })),
			all: Type.Optional(Type.Boolean({ description: "Discard every role." })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			if (params.all) {
				const count = roles.size;
				roles.clear();
				persist({ op: "role_discard_all" });
				return ok(`Discarded all ${count} role(s).`, { action: "agent_discard", roles: [] });
			}
			const name = params.name?.trim();
			if (!name) return fail("agent_discard: pass `name` or `all: true`.", { action: "agent_discard" });
			if (!roles.has(name)) {
				return fail(`No role named "${name}". Existing: ${[...roles.keys()].join(", ") || "(none)"}`, { action: "agent_discard" });
			}
			roles.delete(name);
			persist({ op: "role_discard", name });
			return ok(`Discarded role "${name}". Remaining: ${[...roles.keys()].join(", ") || "(none)"}.`, {
				action: "agent_discard",
				roles: [...roles.values()].map(summarizeRole),
			});
		},
	});

	// -- 子会话工具 ----------------------------------------------------------

	pi.registerTool({
		name: "subsession_create",
		label: "Sub-session: create",
		namespace: roleNamespace,
		promptGuidelines: [
			"A sub-session is the shared context space (a common desk) for one task: put the task context there first, then assign role agents to work on it together.",
		],
		description: `Create a sub-session: a shared workspace ("common desk") for one task. The task's context goes here — goal, acceptance criteria, background data, constraints — not into the agents. Then assign role agents to it and let them collaborate (subsession_run). The sub-session accumulates a desk (findings / decisions / issues / open questions / artifacts) and a work log that all assigned agents share. When finished, subsession_finish returns the result plus extra information.`,
		parameters: Type.Object({
			name: Type.String({ description: 'Unique sub-session name, e.g. "auth-refactor".' }),
			task: Type.String({ description: "The task: goal, deliverable and acceptance criteria. This is what the agents collaborate on." }),
			title: Type.Optional(Type.String({ description: "Short human-readable title." })),
			context: Type.Optional(
				Type.String({ description: "Task context to place in the sub-session's context space: background, data, file excerpts, constraints. More can be added later via subsession_run.context." }),
			),
			assignments: Type.Optional(
				Type.Array(
					Type.Object({
						agent: Type.String({ description: "Existing role name to assign." }),
						focus: Type.Optional(Type.String({ description: "This agent's分工/focus within the sub-session." })),
						lead: Type.Optional(Type.Boolean({ description: "Marks the lead agent (coordinating role)." })),
					}),
					{ description: "Role agents to assign right away. More can be added in subsession_run." },
				),
			),
			synthesisModel: Type.Optional(
				Type.String({ description: 'Model "provider/model-id" used for final synthesis (subsession_finish). Defaults to the lead role\'s model, then the session model.' }),
			),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const name = params.name.trim();
			if (!name) return fail("subsession_create: `name` must not be empty.", { action: "subsession_create" });
			if (subs.has(name)) return fail(`Sub-session "${name}" already exists.`, { action: "subsession_create" });
			const assignments: Assignment[] = [];
			for (const assignment of params.assignments ?? []) {
				const agent = assignment.agent.trim();
				if (!roles.has(agent)) {
					return fail(`Cannot assign unknown role "${agent}". Existing roles: ${[...roles.keys()].join(", ") || "(none)"} — create it with agent_create first.`, {
						action: "subsession_create",
					});
				}
				assignments.push({ agent, focus: assignment.focus?.trim() || undefined, lead: assignment.lead || undefined });
			}
			if (params.synthesisModel !== undefined) {
				const resolved = resolveModel(ctx, params.synthesisModel);
				if (!resolved.model) return fail(resolved.error ?? "model resolution failed", { action: "subsession_create" });
			}
			const now = Date.now();
			const sub: SubSessionState = {
				name,
				title: params.title?.trim() || oneLine(params.task, 80),
				task: params.task,
				synthesisModel: params.synthesisModel?.trim() || undefined,
				context: params.context?.trim() ? [params.context.trim()] : [],
				desk: emptyDesk(),
				assignments,
				log: [],
				rounds: 0,
				status: "open",
				usage: emptyUsage(),
				createdAt: now,
				updatedAt: now,
			};
			subs.set(name, sub);
			persist({ op: "sub_create", sub });
			return ok(
				`Created sub-session "${name}" — ${sub.title}\nTask context: ${sub.context.length} block(s).\nAssigned: ${renderAssignments(sub)}\nNext: run collaboration rounds with subsession_run, then subsession_finish.`,
				{ action: "subsession_create", subsession: summarizeSub(sub) },
			);
		},
	});

	pi.registerTool({
		name: "subsession_run",
		label: "Sub-session: run",
		namespace: roleNamespace,
		description: `Run one collaboration round in a sub-session. Each participating role agent works on the shared desk — seeing the task context, the desk state and the other agents' contributions — and posts its contribution; use desk notes to add context mid-flight. Agents not yet assigned are assigned automatically. Different sub-sessions can run as parallel tool calls; rounds within one sub-session are serialized. Returns a digest of each contribution plus the desk state. Iterate rounds with different instructions until the task is done, then call subsession_finish.`,
		parameters: Type.Object({
			name: Type.String({ description: "Sub-session name." }),
			instruction: Type.String({ description: "What this round should achieve (the shared round instruction for participating agents)." }),
			agents: Type.Optional(
				Type.Array(Type.String(), { description: "Roles participating in this round (default: all assigned). Unassigned names are auto-assigned." }),
			),
			maxTurnsPerAgent: Type.Optional(Type.Number({ description: `Cap on model turns per agent this round (cap ${MAX_TURNS_CAP}).` })),
			context: Type.Optional(Type.String({ description: "Additional task context to place on the shared desk for this round and later rounds." })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
			const name = params.name.trim();
			const sub = subs.get(name);
			if (!sub) {
				return fail(`No sub-session named "${name}". Existing: ${[...subs.keys()].join(", ") || "(none)"}`, { action: "subsession_run" });
			}
			if (sub.status === "done") {
				return fail(`Sub-session "${name}" is already finished. Its result is available from subsession_get (detail="result") or insight_recall.`, {
					action: "subsession_run",
				});
			}

			return withLock(name, async () => {
				const current = subs.get(name);
				if (!current) return fail(`Sub-session "${name}" was discarded before the round started.`, { action: "subsession_run" });

				if (params.context?.trim()) {
					current.context.push(params.context.trim());
					persist({ op: "sub_context", name, context: params.context.trim() });
				}

				// 参与者:显式指定 > 全部分配者;lead 排在最前。
				let participants: Assignment[];
				if (params.agents?.length) {
					participants = [];
					for (const raw of params.agents) {
						const agent = raw.trim();
						if (!roles.has(agent)) {
							return fail(`Unknown role "${agent}". Existing roles: ${[...roles.keys()].join(", ") || "(none)"}`, {
								action: "subsession_run",
							});
						}
						let assignment = current.assignments.find((a) => a.agent === agent);
						if (!assignment) {
							assignment = { agent };
							current.assignments.push(assignment);
							persist({ op: "sub_assign", name, assignments: current.assignments });
						}
						participants.push(assignment);
					}
				} else {
					participants = [...current.assignments];
				}
				if (participants.length === 0) {
					return fail(`Sub-session "${name}" has no agents. Pass agents: ["role"] (roles are created with agent_create).`, {
						action: "subsession_run",
					});
				}
				participants.sort((a, b) => Number(!!b.lead) - Number(!!a.lead));

				const round = current.rounds + 1;
				const appended: LogEntry[] = [];
				const roundUsage = emptyUsage();
				const digest: string[] = [];

				for (const assignment of participants) {
					const role = roles.get(assignment.agent);
					if (!role) continue;
					const systemPrompt = buildTurnPrompt(role, current, assignment);
					const instruction = [
						`# 子会话 "${current.title}" 第 ${round} 轮`,
						`本轮指令:${params.instruction}`,
						assignment.focus ? `你的分工:${assignment.focus}` : "",
						`用 desk_update 把关键发现 / 决策 / 异常 / 待决问题写上公共桌面,然后用一段文字给出你的贡献(结论、依据、建议)。`,
					]
						.filter(Boolean)
						.join("\n");

					const turn = await runTurn(
						{
							model: optsModel(ctx, role.config.model),
							systemPrompt,
							instruction,
							toolNames: [...role.config.tools, "desk_update"],
							maxTurns: Math.min(
								role.config.maxTurns,
								Math.max(1, Math.min(MAX_TURNS_CAP, Math.round(params.maxTurnsPerAgent ?? MAX_TURNS_CAP))),
							),
						},
						ctx,
						signal,
						onUpdate,
						`role:${role.config.name}`,
					);

					const entry: LogEntry = {
						agent: role.config.name,
						focus: assignment.focus,
						instruction,
						contribution: turn.text || (turn.errorMessage ? `[error] ${turn.errorMessage}` : "(no contribution)"),
						turns: turn.turns,
						toolCalls: turn.toolCalls,
						usage: turn.usage,
						timestamp: Date.now(),
					};
					appendLog(current, entry);
					appended.push(entry);
					addUsage(roundUsage, turn.usage);
					addUsage(role.usage, turn.usage);
					role.runs += 1;
					role.updatedAt = Date.now();
					persist({ op: "role_stats", name: role.config.name, runs: role.runs, usage: role.usage });
					persist({ op: "role_stats", name: role.config.name, runs: role.runs, usage: role.usage });

					digest.push(
						`[${role.config.name}${assignment.lead ? " · lead" : ""}${assignment.focus ? ` · ${assignment.focus}` : ""}] ${turn.turns} turn(s), ${turn.toolCalls} tool call(s), stop:${turn.stopReason}, ${formatUsage(turn.usage)}\n${truncate(entry.contribution, 2_000)}`,
					);
				}

				current.rounds = round;
				current.updatedAt = Date.now();
				addUsage(current.usage, roundUsage);
				persist({ op: "sub_run", name, log: appended, desk: current.desk, rounds: round, usage: roundUsage });

				const header = `Sub-session "${name}" round ${round} · ${appended.length} contribution(s) · ${formatUsage(roundUsage)}`;
				const deskState = `Desk now:\n${renderDesk(current.desk)}`;
				return ok(truncate(`${header}\n\n${digest.join("\n\n---\n\n")}\n\n${deskState}`, MAX_RESULT_CHARS), {
					action: "subsession_run",
					subsession: summarizeSub(current),
					round,
					contributions: appended.map((entry) => ({ agent: entry.agent, turns: entry.turns, toolCalls: entry.toolCalls })),
				}, roundUsage);
			});
		},
	});

	pi.registerTool({
		name: "subsession_finish",
		label: "Sub-session: finish",
		namespace: roleNamespace,
		promptGuidelines: [
			"When a sub-session finishes, keep BOTH parts it returns: the result (what was concluded) and the extra info (how it was solved, anomalies hit, lessons) — the extra info often informs later work, and insight_recall brings it back.",
		],
		description: `Finish a sub-session: synthesize the desk and work log into a final deliverable and return it in two parts — 1) 结果/result: the task outcome or conclusion; 2) 额外信息/extras: valuable process information (solution approach, anomalies and problems hit mid-way, reusable lessons). Both parts are also written into the cross-session experience memory so later tasks can recall them (insight_recall) and receive them as automatic inspiration. Idempotent: calling again returns the stored result.`,
		parameters: Type.Object({
			name: Type.String({ description: "Sub-session name." }),
			guidance: Type.Optional(Type.String({ description: "Extra guidance for the synthesis (emphasis, format, what to highlight in extras)." })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const name = params.name.trim();
			const sub = subs.get(name);
			if (!sub) {
				return fail(`No sub-session named "${name}". Existing: ${[...subs.keys()].join(", ") || "(none)"}`, { action: "subsession_finish" });
			}
			if (sub.status === "done" && sub.result !== undefined) {
				return ok(renderResult(sub), { action: "subsession_finish", subsession: summarizeSub(sub), result: sub.result, extras: sub.extras ?? "" });
			}

			return withLock(name, async () => {
				const current = subs.get(name);
				if (!current) return fail(`Sub-session "${name}" was discarded.`, { action: "subsession_finish" });
				if (current.status === "done" && current.result !== undefined) {
					return ok(renderResult(current), {
						action: "subsession_finish",
						subsession: summarizeSub(current),
						result: current.result,
						extras: current.extras ?? "",
					});
				}

				let model: Model<Api>;
				try {
					const lead = current.assignments.find((a) => a.lead) ?? current.assignments[0];
					const leadModel = lead ? roles.get(lead.agent)?.config.model : undefined;
					model = optsModel(ctx, current.synthesisModel || leadModel || "");
				} catch (error) {
					return fail(error instanceof Error ? error.message : String(error), { action: "subsession_finish" });
				}

				const prompt = buildSynthesisPrompt(current, params.guidance?.trim());
				const usage = emptyUsage();
				let text = "";
				try {
					const response = await ctx.modelRegistry.complete(
						model,
						{
							systemPrompt: prompt,
							messages: [{ role: "user", content: "请综合以上子会话的产出,严格按照规定的格式输出。", timestamp: Date.now() }],
						},
						{ signal },
					);
					addUsage(usage, response.usage);
					if (response.stopReason === "error") {
						return fail(`Synthesis failed: ${response.errorMessage ?? "unknown error"}`, { action: "subsession_finish" });
					}
					text = textOf(response);
				} catch (error) {
					return fail(`Synthesis failed: ${error instanceof Error ? error.message : String(error)}`, { action: "subsession_finish" });
				}

				const parsed = parseSynthesis(text);

				current.status = "done";
				current.result = parsed.result;
				current.extras = parsed.extras;
				current.updatedAt = Date.now();
				const insights = collectInsights(parsed.insights, current, ctx.cwd);
				addUsage(current.usage, usage);
				persist({ op: "sub_finish", name, result: parsed.result, extras: parsed.extras, desk: current.desk, usage });

				if (insights.length > 0) {
					ensureStore();
					store.add(insights);
				}

				const tail = `\n\n(已沉淀 ${insights.length} 条经验到跨会话记忆;后续任务可调用 insight_recall 召回,或在开始新任务时自动获得相关启发)`;
				return ok(truncate(`${renderResult(current)}${tail}`, MAX_RESULT_CHARS), {
					action: "subsession_finish",
					subsession: summarizeSub(current),
					result: parsed.result,
					extras: parsed.extras,
					insights: insights.map((insight) => ({ kind: insight.kind, text: oneLine(insight.text, 120) })),
				}, usage);
			});
		},
	});

	pi.registerTool({
		name: "subsession_get",
		label: "Sub-session: get",
		namespace: roleNamespace,
		description: `Inspect sub-sessions. Without name, lists all. With name, returns the requested detail: "summary" (status, task, desk counts, assignments), "desk" (the shared desk), "log" (work log digest), or "result" (result + extras of a finished sub-session).`,
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Sub-session name; omit to list all." })),
			detail: Type.Optional(Type.String({ description: 'One of "summary" (default), "desk", "log", "result".' })),
			logLimit: Type.Optional(Type.Number({ description: "Max log entries for detail=log (default 10)." })),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false },
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			const detail = (params.detail ?? "summary").trim();
			const name = params.name?.trim();
			if (!name) {
				const lines = [...subs.values()].map(
					(sub) =>
						`- ${sub.name} [${sub.status}] ${sub.title} · rounds ${sub.rounds} · agents: ${renderAssignments(sub)} · ${formatUsage(sub.usage)}`,
				);
				return ok(`Sub-sessions: ${subs.size}\n${lines.join("\n") || "  (none)"}`, {
					action: "subsession_get",
					subsessions: [...subs.values()].map(summarizeSub),
				});
			}
			const sub = subs.get(name);
			if (!sub) return fail(`No sub-session named "${name}". Existing: ${[...subs.keys()].join(", ") || "(none)"}`, { action: "subsession_get" });

			if (detail === "desk") {
				return ok(`Desk of "${name}":\n${renderDesk(sub.desk, false)}`, { action: "subsession_get", subsession: summarizeSub(sub), desk: sub.desk });
			}
			if (detail === "log") {
				const limit = Math.max(1, Math.min(MAX_TURN_LOG, Math.round(params.logLimit ?? 10)));
				return ok(`Work log of "${name}" (last ${limit}):\n${renderLogDigest(sub, limit)}`, {
					action: "subsession_get",
					subsession: summarizeSub(sub),
					log: sub.log.slice(-limit).map((entry) => ({ agent: entry.agent, contribution: truncate(entry.contribution, 1_000), turns: entry.turns })),
				});
			}
			if (detail === "result") {
				if (sub.status !== "done") return fail(`Sub-session "${name}" is still open (rounds ${sub.rounds}). Finish it with subsession_finish.`, { action: "subsession_get" });
				return ok(renderResult(sub), { action: "subsession_get", subsession: summarizeSub(sub), result: sub.result, extras: sub.extras ?? "" });
			}
			return ok(
				[
					`Sub-session "${sub.name}" [${sub.status}] — ${sub.title}`,
					`Task: ${oneLine(sub.task, 600)}`,
					`Context blocks: ${sub.context.length} · rounds: ${sub.rounds} · usage: ${formatUsage(sub.usage)}`,
					`Agents: ${renderAssignments(sub)}`,
					`Desk: ${DESK_SECTIONS.map((s) => `${s} ${sub.desk[s].length}`).join(" · ")}`,
					sub.status === "done" ? `Result: ${oneLine(sub.result ?? "", 300)}` : `Use subsession_run to work, subsession_finish to conclude.`,
				].join("\n"),
				{ action: "subsession_get", subsession: summarizeSub(sub) },
			);
		},
	});

	pi.registerTool({
		name: "subsession_discard",
		label: "Sub-session: discard",
		namespace: roleNamespace,
		description: `Discard sub-sessions that are no longer needed: one by name, or all with all=true. Discarding frees their desk and work log; finished results already in the experience memory stay recallable via insight_recall.`,
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Sub-session name to discard." })),
			all: Type.Optional(Type.Boolean({ description: "Discard every sub-session." })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			if (params.all) {
				const count = subs.size;
				subs.clear();
				persist({ op: "sub_discard_all" });
				return ok(`Discarded all ${count} sub-session(s).`, { action: "subsession_discard", subsessions: [] });
			}
			const name = params.name?.trim();
			if (!name) return fail("subsession_discard: pass `name` or `all: true`.", { action: "subsession_discard" });
			if (!subs.has(name)) {
				return fail(`No sub-session named "${name}". Existing: ${[...subs.keys()].join(", ") || "(none)"}`, { action: "subsession_discard" });
			}
			subs.delete(name);
			persist({ op: "sub_discard", name });
			return ok(`Discarded sub-session "${name}". Remaining: ${[...subs.keys()].join(", ") || "(none)"}.`, {
				action: "subsession_discard",
				subsessions: [...subs.values()].map(summarizeSub),
			});
		},
	});

	// -- 经验记忆工具 --------------------------------------------------------

	pi.registerTool({
		name: "insight_recall",
		label: "Insight: recall",
		namespace: roleNamespace,
		promptGuidelines: [
			"Before tackling a task that resembles past work, call insight_recall once — it brings back results and process know-how (approach, anomalies, lessons) from earlier sub-sessions in milliseconds.",
		],
		description: `Recall results and extra information from finished sub-sessions (and manually added insights) with a fast, RAG-like search: ranked retrieval over the cross-session experience memory, no model call, returns instantly. Returns both the conclusion (kind=result) and process know-how (approach / anomaly / lesson / finding / decision) with provenance so you can trace back to the sub-session that produced it. Query in the language of the task; use kinds/scope to narrow.`,
		parameters: Type.Object({
			query: Type.String({ description: "What to look for: a task description, symptom, technology, or question." }),
			kinds: Type.Optional(
				Type.Array(Type.String(), { description: `Filter by kind: ${INSIGHT_KINDS.join(", ")}. Default: all.` }),
			),
			limit: Type.Optional(Type.Number({ description: "Max results (default 6)." })),
			scope: Type.Optional(Type.String({ description: '"project" (default) recalls this project\'s memory; "all" searches every project.' })),
			detail: Type.Optional(Type.Boolean({ description: "Return fuller text per result (default false, one-line snippets)." })),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false },
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			ensureStore();
			const kinds = (params.kinds ?? []).map((kind) => kind.trim()).filter((kind): kind is InsightKind => (INSIGHT_KINDS as string[]).includes(kind));
			const hits = store.search(params.query, {
				limit: params.limit ?? 6,
				kinds: kinds.length ? kinds : undefined,
				cwd: ctx.cwd,
				scope: params.scope === "all" ? "all" : "project",
			});
			if (hits.length === 0) {
				return ok(
					`No insights matched "${params.query}" (memory size: ${store.size}). Try different keywords, scope:"all", or record new knowledge with insight_add.`,
					{ action: "insight_recall", hits: [] },
				);
			}
			const detail = params.detail === true;
			const lines = hits.map((hit, index) => {
				const record = hit.record;
				const body = detail ? truncate(record.text, 1_500) : oneLine(record.text, 300);
				return `${index + 1}. [${record.kind}] score ${hit.score.toFixed(1)} · ${record.title || record.source} · ${new Date(record.timestamp).toISOString().slice(0, 10)}${record.agent ? ` · ${record.agent}` : ""}\n   ${body}\n   (matched: ${hit.matched.slice(0, 8).join(", ")}; source: ${record.source})`;
			});
			return ok(
				`Recalled ${hits.length} insight(s) for "${params.query}":\n\n${lines.join("\n\n")}\n\nTip: insight_recall with detail:true or kinds:[...] for more; insight_add to record new knowledge.`,
				{
					action: "insight_recall",
					hits: hits.map((hit) => ({
						id: hit.record.id,
						kind: hit.record.kind,
						score: hit.score,
						source: hit.record.source,
						text: oneLine(hit.record.text, 200),
					})),
				},
			);
		},
	});

	pi.registerTool({
		name: "insight_add",
		label: "Insight: add",
		namespace: roleNamespace,
		description: `Record a piece of experience into the cross-session memory so later tasks can recall it (insight_recall) or receive it as automatic inspiration. Use it for durable know-how worth keeping: surprising findings, reusable approaches, pitfalls, decisions with rationale. Results and extras of finished sub-sessions are recorded automatically by subsession_finish.`,
		parameters: Type.Object({
			text: Type.String({ description: "The insight: one concrete, self-contained statement." }),
			kind: Type.Optional(Type.String({ description: `One of ${INSIGHT_KINDS.join(", ")} (default "note").` })),
			title: Type.Optional(Type.String({ description: "Short label, e.g. the task or area it came from." })),
			source: Type.Optional(Type.String({ description: "Where it came from (defaults to \"manual\")." })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			ensureStore();
			const kind: InsightKind = (INSIGHT_KINDS as string[]).includes(params.kind?.trim() ?? "")
				? (params.kind!.trim() as InsightKind)
				: "note";
			const record: InsightRecord = {
				id: store.nextId(),
				kind,
				title: params.title?.trim() || "",
				text: params.text.trim(),
				source: params.source?.trim() || "manual",
				cwd: ctx.cwd,
				timestamp: Date.now(),
			};
			store.add([record]);
			return ok(`Recorded insight ${record.id} [${kind}]. Memory size: ${store.size}.`, {
				action: "insight_add",
				insight: { id: record.id, kind, text: oneLine(record.text, 120) },
			});
		},
	});

	// -- 内部:提示词 / 摘要 / 解析 ------------------------------------------

	function summarizeRole(role: RoleState): Record<string, unknown> {
		return {
			name: role.config.name,
			description: role.config.description,
			model: role.config.model,
			tools: role.config.tools,
			maxTurns: role.config.maxTurns,
			contextChunks: role.contexts.length,
			runs: role.runs,
			usage: role.usage,
		};
	}

	function summarizeSub(sub: SubSessionState): Record<string, unknown> {
		return {
			name: sub.name,
			title: sub.title,
			status: sub.status,
			rounds: sub.rounds,
			assignments: sub.assignments,
			deskCounts: Object.fromEntries(DESK_SECTIONS.map((section) => [section, sub.desk[section].length])),
			logEntries: sub.log.length,
			usage: sub.usage,
		};
	}

	function buildTurnPrompt(role: RoleState, sub: SubSessionState, assignment: Assignment): string {
		const parts: string[] = [role.config.systemPrompt.trim()];
		if (role.contexts.length > 0) parts.push(`## 角色补充上下文\n${role.contexts.join("\n\n---\n\n")}`);
		parts.push(
			[
				`## 子会话工作台:${sub.title}(name: ${sub.name})`,
				`你是这个子会话中协作的一员。多名角色 agent 在同一张"公共桌面"上协作:`,
				`你们通过桌面(desk_update 写入发现 / 决策 / 异常 / 待决问题)和工作日志互相交流。`,
				`参考桌面上他人的贡献,补充他们没覆盖的部分,不要重复劳动。`,
				``,
				`### 任务目标`,
				sub.task.trim(),
				``,
				`### 任务上下文(指派进本子会话的上下文空间)`,
				sub.context.length ? sub.context.map((block) => truncate(block, 3_000)).join("\n\n---\n\n") : "(none)",
				``,
				`### 公共桌面(desk)`,
				renderDesk(sub.desk),
				``,
				`### 工作日志(最近的贡献,含其他 agent)`,
				renderLogDigest(sub),
			].join("\n"),
		);
		parts.push(
			[
				`### 你的角色与本轮工作`,
				`你是 "${role.config.name}"(${role.config.description})。${assignment.focus ? `你的分工:${assignment.focus}` : ""}`,
				`完成本轮指令后,用一段文字给出你的贡献:结论、依据、建议,以及你认为他人需要知道的异常或风险。`,
			].join("\n"),
		);
		return parts.join("\n\n");
	}

	function buildSynthesisPrompt(sub: SubSessionState, guidance: string | undefined): string {
		return [
			`你是一个多 agent 子会话的总结负责人。请把下面的协作产出综合成最终交付,并严格按格式输出(中文)。`,
			``,
			`# 任务目标`,
			sub.task.trim(),
			``,
			`# 任务上下文`,
			sub.context.length ? sub.context.map((block) => truncate(block, 2_000)).join("\n\n---\n\n") : "(none)",
			``,
			`# 公共桌面`,
			renderDesk(sub.desk, false),
			``,
			`# 工作日志`,
			renderLogDigest(sub, 20),
			guidance ? `\n# 额外要求\n${guidance}` : "",
			``,
			`# 输出格式(必须严格遵守,不要输出格式之外的任何内容)`,
			`## 结果`,
			`<任务完成情况或结论。要完整、可独立使用、直接回答任务目标。>`,
			``,
			`## 额外信息`,
			`### 解决路径`,
			`<怎么解决的:关键步骤、取舍、方案选择>`,
			`### 异常与问题`,
			`<中途遇到的异常、错误、走过的弯路、当前仍未解决的问题>`,
			`### 经验与启发`,
			`<可迁移的经验、教训、给后续类似任务的建议>`,
			``,
			`## insights`,
			`\`\`\`json`,
			`[{"kind": "approach|anomaly|lesson|finding|decision|result", "text": "一条自包含的经验,不超过 200 字"}, ...]`,
			`\`\`\``,
			`(insights 数组 3~10 条,提炼最值得长期记住的内容;kind 取值:approach 解决方式 / anomaly 异常 / lesson 经验教训 / finding 发现 / decision 决策 / result 结论)`,
		].join("\n");
	}

	function parseSynthesis(text: string): { result: string; extras: string; insights: { kind: InsightKind; text: string }[] } {
		const lines = text.split("\n");
		let resultStart = -1;
		let extrasStart = -1;
		let insightsStart = -1;
		for (let i = 0; i < lines.length; i++) {
			const match = lines[i].match(/^#{1,3}\s*(\S.*)$/);
			if (!match) continue;
			const title = match[1].trim().toLowerCase();
			if (resultStart < 0 && /^(result|结果)/.test(title)) resultStart = i + 1;
			else if (extrasStart < 0 && /^(extras?|额外信息|附加信息)/.test(title)) extrasStart = i + 1;
			else if (insightsStart < 0 && /^(insights?|经验清单|经验记录)/.test(title)) insightsStart = i + 1;
		}

		const slice = (from: number, to: number): string => lines.slice(from, to).join("\n").trim();
		let result: string;
		let extras = "";
		if (resultStart >= 0) {
			const resultEnd =
				[extrasStart, insightsStart, lines.length].filter((index) => index > resultStart).sort((a, b) => a - b)[0] ?? lines.length;
			result = slice(resultStart, resultEnd);
			if (extrasStart >= 0) {
				const extrasEnd = insightsStart > extrasStart ? insightsStart : lines.length;
				extras = slice(extrasStart, extrasEnd);
			}
		} else {
			// 模型没按标题格式输出:整个文本当作结果。
			result = text.trim();
		}
		if (!result) result = text.trim();

		const insights: { kind: InsightKind; text: string }[] = [];
		const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
		for (const block of blocks.reverse()) {
			try {
				const parsed = JSON.parse(block[1].trim());
				if (!Array.isArray(parsed)) continue;
				for (const item of parsed) {
					const insightText = typeof item?.text === "string" ? item.text.trim() : "";
					if (!insightText) continue;
					const kind: InsightKind = (INSIGHT_KINDS as string[]).includes(item?.kind) ? item.kind : "note";
					insights.push({ kind, text: insightText });
				}
				break;
			} catch {
				// 尝试下一个代码块
			}
		}
		return { result, extras, insights };
	}

	/** 结果 + 额外信息 + 桌面沉淀,合并成要记录的经验条目。 */
	function collectInsights(
		parsed: { kind: InsightKind; text: string }[],
		sub: SubSessionState,
		cwd: string,
	): InsightRecord[] {
		const now = Date.now();
		const records: InsightRecord[] = [];
		const push = (kind: InsightKind, text: string) => {
			const trimmed = text.trim();
			if (!trimmed) return;
			records.push({
				id: store.nextId(),
				kind,
				title: sub.title,
				text: truncate(trimmed, 600),
				source: sub.name,
				cwd,
				timestamp: now,
			});
		};
		push("result", sub.result ?? "");
		for (const insight of parsed) push(insight.kind, insight.text);
		// 兜底:总结没提炼出多少时,把桌面内容也沉淀下来。
		if (parsed.length < 3) {
			for (const issue of sub.desk.issues.slice(-5)) push("anomaly", issue);
			for (const decision of sub.desk.decisions.slice(-5)) push("decision", decision);
			for (const finding of sub.desk.findings.slice(-5)) push("finding", finding);
		}
		return records.slice(0, 16);
	}

	function renderResult(sub: SubSessionState): string {
		return [
			`# 子会话 "${sub.name}" — ${sub.title}`,
			``,
			`## 结果 (result)`,
			sub.result?.trim() || "(empty)",
			``,
			`## 额外信息 (extras)`,
			sub.extras?.trim() || "(empty)",
		].join("\n");
	}
}
