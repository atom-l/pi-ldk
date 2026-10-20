/**
 * Session Management Commands
 *
 * Project-local extension providing focused slash commands for managing
 * sessions IN THIS PROJECT. Designed to make clearing and deleting sessions
 * less awkward than navigating /resume + Ctrl+D.
 *
 *   /session-new        (/sn,   /clear)    Start a new session — clears the current conversation
 *   /session-list       (/sl,   /sessions) List this project's sessions and switch to one
 *   /session-delete    (/sd,   /sdel)     List this project's sessions and delete one
 *   /session-delete-all (/sda,  /sdel-all)  Delete all sessions except the current one
 *   /session-merge      (/sm,   /merge)    Merge another session's conversation into the current one,
 *                                          then ask the model to synthesize a refined summary
 *                                          (append `raw` to skip summarization, e.g. /sm raw)
 *
 * Deletion is permanent (files are removed directly).
 *
 * `/session-merge` imports a (child/forked) session's resolved conversation as a
 * single visible context message in the current session, then (by default) sends a
 * follow-up prompt asking the current model to distill BOTH discussions into one
 * concise shared-context summary. The source session file is left untouched.
 * Pass `raw` (/sm raw) to inject the transcript only, with no summarization turn.
 *
 * Loaded automatically from .pi/extensions/. After editing, run /reload in pi.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { rmSync } from "node:fs";

type Ctx = ExtensionCommandContext;

/** List sessions for the current project, most-recent first. */
async function listSessions(ctx: Ctx) {
	const cwd = ctx.sessionManager.getCwd();
	const sessionDir = ctx.sessionManager.getSessionDir();
	const sessions = await SessionManager.list(cwd, sessionDir);
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

/** Build a readable one-line label for the session picker. */
function sessionLabel(
	s: { name?: string; firstMessage: string; messageCount: number; modified: Date },
	index: number,
	isCurrent: boolean,
): string {
	const title = s.name?.trim() || s.firstMessage.slice(0, 50).trim() || "(empty session)";
	const date = s.modified.toISOString().slice(0, 16).replace("T", " ");
	const cur = isCurrent ? "  [current]" : "";
	return `${index + 1}. ${title}  ·  ${s.messageCount} msgs  ·  ${date}${cur}`;
}

/** Register a command under multiple names (primary + short aliases). */
function register(
	pi: ExtensionAPI,
	names: string[],
	opts: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> },
): void {
	for (const name of names) pi.registerCommand(name, opts);
}

// ---------------------------------------------------------------------------
// /session-merge helpers
// ---------------------------------------------------------------------------

/** Truncate text to `max` chars, appending a note when content was cut. */
function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…(${text.length - max} chars truncated)`;
}

/** Extract text from a message content (string or content-block array). */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Array<{ type?: string; text?: string }>) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

/** Format a single AgentMessage as readable markdown-ish text for merging. */
function formatMessage(msg: AgentMessage): string {
	switch (msg.role) {
		case "user":
			return `### User\n${textOf((msg as { content: unknown }).content).trim()}`;
		case "assistant": {
			const blocks = (msg as { content?: unknown[] }).content;
			const parts: string[] = [];
			if (Array.isArray(blocks)) {
				for (const b of blocks as Array<{
					type?: string;
					text?: string;
					name?: string;
					arguments?: unknown;
				}>) {
					if (!b) continue;
					if (b.type === "text" && b.text) parts.push(b.text);
					else if (b.type === "toolCall") {
						const args = truncate(JSON.stringify(b.arguments ?? {}, null, 2), 400);
						parts.push(`[tool call: ${b.name}]\n${args}`);
					}
					// thinking blocks are intentionally skipped — they bloat context
				}
			}
			return `### Assistant\n${(parts.join("\n") || "(no text)").trim()}`;
		}
		case "toolResult": {
			const m = msg as { toolName: string; content: unknown; isError?: boolean };
			return `### Tool result: ${m.toolName}${m.isError ? " (error)" : ""}\n${truncate(
				textOf(m.content),
				600,
			)}`;
		}
		case "bashExecution": {
			const m = msg as { command: string; output: string; exitCode?: number };
			const code = m.exitCode === undefined ? "" : ` (exit ${m.exitCode})`;
			return `### Bash${code}\n$ ${m.command}\n${truncate(m.output ?? "", 600)}`;
		}
		case "custom": {
			const m = msg as { customType: string; content: unknown };
			return `### [${m.customType}]\n${textOf(m.content).trim()}`;
		}
		case "branchSummary":
			return `### Branch summary\n${(msg as { summary: string }).summary}`;
		case "compactionSummary":
			return `### Compaction summary\n${(msg as { summary: string }).summary}`;
		default:
			return "";
	}
}

/** Render a whole conversation as a merge transcript. */
function formatTranscript(messages: AgentMessage[], source: SessionInfo): string {
	const title = source.name?.trim() || source.firstMessage.slice(0, 80).trim() || "(unnamed session)";
	const date = source.modified.toISOString().slice(0, 16).replace("T", " ");
	const header = [
		"# Merged session",
		`source: ${title}`,
		`messages: ${source.messageCount}  ·  modified: ${date}`,
		"---",
	].join("\n");
	const body = messages.map(formatMessage).filter(Boolean).join("\n\n");
	return `${header}\n\n${body}`;
}

/**
 * Prompt sent after a merge (unless `/sm raw`) so the current model distills both
 * the current session's discussion and the merged branch into one concise
 * shared-context summary. The reply becomes the refined context going forward.
 */
const MERGE_SUMMARY_PROMPT = `上方标为 "Merged session" 的内容，是刚从另一个 session 合并进来的讨论记录。请综合【当前 session 此前的讨论】与【这段合并进来的讨论】，产出一份精炼的合并上下文摘要，作为后续工作的共享上下文。

请覆盖：
1. 两边各自的目标、关键结论与已做出的决策
2. 涉及的文件及其改动状态
3. 两边的分歧或尚未解决的问题
4. 建议的后续步骤

要求：简明扼要，用结构化要点呈现，不要逐条复述原始对话。`;

export default function sessionsExtension(pi: ExtensionAPI): void {
	// /session-new | /sn | /clear
	register(pi, ["session-new", "sn", "clear"], {
		description: "Start a new session (clears the current conversation; old session is saved)",
		handler: async (_args, ctx) => {
			const hadSession = !!ctx.sessionManager.getSessionFile();
			const message = hadSession
				? "New session started (previous one saved)"
				: "New session started";
			const res = await ctx.newSession({
				withSession: async (newCtx) => {
					newCtx.ui.notify(message, "info");
				},
			});
			if (res.cancelled) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
		},
	});

	// /session-list | /sl | /sessions
	register(pi, ["session-list", "sl", "sessions"], {
		description: "List this project's sessions and switch to one",
		handler: async (_args, ctx) => {
			const sessions = await listSessions(ctx);
			if (sessions.length === 0) {
				ctx.ui.notify("No sessions found for this project", "info");
				return;
			}
			const current = ctx.sessionManager.getSessionFile();
			const options = sessions.map((s, i) => sessionLabel(s, i, s.path === current));
			const sel = await ctx.ui.select("Switch to session", options);
			if (!sel) return;
			const target = sessions[options.indexOf(sel)];
			const label = target.name || target.firstMessage.slice(0, 40) || "session";
			const res = await ctx.switchSession(target.path, {
				withSession: async (newCtx) => {
					newCtx.ui.notify(`Switched to: ${label}`, "info");
				},
			});
			if (res.cancelled) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
		},
	});

	// /session-delete | /sd | /sdel
	register(pi, ["session-delete", "sd", "sdel"], {
		description: "List this project's sessions and delete one",
		handler: async (_args, ctx) => {
			const sessions = await listSessions(ctx);
			if (sessions.length === 0) {
				ctx.ui.notify("No sessions found for this project", "info");
				return;
			}
			const current = ctx.sessionManager.getSessionFile();
			const options = sessions.map((s, i) => sessionLabel(s, i, s.path === current));
			const sel = await ctx.ui.select("Delete session", options);
			if (!sel) return;
			const target = sessions[options.indexOf(sel)];
			const isCurrent = target.path === current;
			const warning = isCurrent
				? "\n\nThis is the CURRENT session — a new empty session will start after deletion."
				: "";
			const ok = await ctx.ui.confirm("Delete session?", `${target.path}${warning}`);
			if (!ok) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			// rmSync 对已被外部删除/权限不足的路径会抛(ENOENT/EPERM/EISDIR),
			// 在 async handler 中即为未处理拒绝;这里降级为提示,不阻断后续流程。
			try {
				rmSync(target.path);
			} catch (err) {
				ctx.ui.notify(`Failed to delete ${target.path}: ${err instanceof Error ? err.message : String(err)}`, "warning");
				return;
			}
			if (isCurrent) {
				const res = await ctx.newSession({
					withSession: async (newCtx) => {
						newCtx.ui.notify("Session deleted", "info");
					},
				});
				if (res.cancelled) ctx.ui.notify("Cancelled", "info");
			} else {
				ctx.ui.notify("Session deleted", "info");
			}
		},
	});

	// /session-delete-all | /sda | /sdel-all
	register(pi, ["session-delete-all", "sda", "sdel-all"], {
		description: "Delete all this project's sessions except the current one",
		handler: async (_args, ctx) => {
			const sessions = await listSessions(ctx);
			const current = ctx.sessionManager.getSessionFile();
			const targets = sessions.filter((s) => s.path !== current);
			if (targets.length === 0) {
				ctx.ui.notify("No other sessions to delete", "info");
				return;
			}
			const ok = await ctx.ui.confirm(
				"Delete all other sessions?",
				`${targets.length} session(s) will be permanently deleted.\nThe current session is kept.`,
			);
			if (!ok) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			let n = 0;
			let failed = 0;
			for (const s of targets) {
				// 单个删除失败(已不存在 / 权限不足)不应中断整批;计数并继续。
				try {
					rmSync(s.path);
					n++;
				} catch {
					failed++;
				}
			}
			ctx.ui.notify(`Deleted ${n} session(s)${failed ? `, ${failed} failed` : ""}`, failed ? "warning" : "info");
		},
	});

	// /session-merge | /sm | /merge
	register(pi, ["session-merge", "sm", "merge"], {
		description: "Merge another session's conversation into the current session as context",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("session-merge requires interactive UI", "warning");
				return;
			}
			// `/sm raw` (or no-summary/merge-only) injects only the transcript.
			// Otherwise the current model is asked to synthesize a refined summary.
			const wantSummary = !/^(raw|no-summary|nosummary|merge-only)$/i.test(args.trim());
			const current = ctx.sessionManager.getSessionFile();
			const sessions = await listSessions(ctx);
			// Cannot merge a session into itself.
			const candidates = sessions.filter((s) => s.path !== current);
			if (candidates.length === 0) {
				ctx.ui.notify("No other sessions to merge from", "info");
				return;
			}

			const options = candidates.map((s, i) => sessionLabel(s, i, false));
			const sel = await ctx.ui.select("Merge which session into the current one?", options);
			if (!sel) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			const source = candidates[options.indexOf(sel)];

			const ok = await ctx.ui.confirm(
				"Merge session into current?",
				`Source: ${source.name || source.firstMessage.slice(0, 60) || "session"}\n` +
					`(${source.messageCount} messages)\n\n` +
					"The source conversation will be appended to the current session as context.\n" +
					"The source session file is not modified or deleted.",
			);
			if (!ok) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Open the source session read-only and resolve its full context
			// (handles compaction + branch summaries, so we get the real "results").
			const sessionDir = ctx.sessionManager.getSessionDir();
			const cwd = ctx.sessionManager.getCwd();
			let sourceManager: SessionManager;
			try {
				sourceManager = SessionManager.open(source.path, sessionDir, cwd);
			} catch (e) {
				ctx.ui.notify(
					`Failed to open source session: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
				return;
			}
			const { messages } = sourceManager.buildSessionContext();
			if (messages.length === 0) {
				ctx.ui.notify("Source session has no messages to merge", "info");
				return;
			}

			const transcript = formatTranscript(messages, source);

			// Ensure the agent is idle so sendMessage persists immediately
			// (otherwise it would be delivered as a steering message, not written).
			await ctx.waitForIdle();

			pi.sendMessage(
				{
					customType: "session-merge",
					content: transcript,
					display: true,
					details: {
						sourcePath: source.path,
						sourceId: source.id,
						sourceName: source.name,
						messageCount: source.messageCount,
						summarized: wantSummary,
					},
				},
				{ triggerTurn: false },
			);

			const label = source.name || source.firstMessage.slice(0, 40) || "session";

			if (!wantSummary) {
				ctx.ui.notify(
					`Merged ${messages.length} message(s) from "${label}" into the current session as context`,
					"info",
				);
				return;
			}

			// Ask the current model to distill BOTH the current session's discussion
			// and the merged branch into one concise shared-context summary. This
			// triggers a turn, so the reply is streamed as a normal assistant message
			// and becomes the refined context going forward. The transcript is pushed
			// synchronously above (idle branch), so it is already in context when the
			// summarization turn starts.
			pi.sendUserMessage(MERGE_SUMMARY_PROMPT);
			ctx.ui.notify(
				`Merged ${messages.length} message(s) from "${label}"; asking the model to synthesize a refined summary…`,
				"info",
			);
		},
	});
}
