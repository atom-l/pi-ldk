/**
 * mcp-adapter — load MCP servers from `.pi/mcp-adapter.json`
 *
 * Pi's built-in MCP support reads `mcp.json`. This extension reads an additional
 * config file, `.pi/mcp-adapter.json` (project) and `~/.pi/agent/mcp-adapter.json`
 * (global), translates each entry to pi's `mcpServers` shape, and registers the
 * servers with `pi.registerMcpServer()`. The built-in MCP support connects them
 * next to the `mcp.json` servers, so `/mcp`, `pi mcp`, OAuth sign-in, codemode,
 * and permissions all keep working.
 *
 * The file uses the familiar `mcpServers` shape and additionally accepts fields
 * pi does not use (opencode-style entries):
 *
 *   {
 *     "mcpServers": {
 *       "web-search": {
 *         "type": "remote",                      // remote/http/streamable-http/sse, or local/stdio
 *         "url": "https://example.com/mcp",
 *         "headers": { "Authorization": "Bearer ${TOKEN}" },
 *         "directTools": true                    // true → exposure: "direct"
 *       },
 *       "files": {
 *         "type": "local",
 *         "command": ["npx", "-y", "server-filesystem", "."],   // array form also works
 *         "environment": { "KEY": "${KEY}" },    // alias of env
 *         "exposure": "codemode"
 *       }
 *     }
 *   }
 *
 * Mapping rules:
 *   - `type: "remote"` (and `http`/`https`/`sse`/`url`)  → HTTP server; `type` is dropped
 *   - `type: "local"`  (and `stdio`/`subprocess`/…)      → stdio server; `type` is dropped
 *   - missing `type` is inferred from `url` vs `command`
 *   - `command: ["npx", "-y", "pkg"]` is split into `command` + `args`
 *   - `environment` → `env`; a string `args` is split into words
 *   - `directTools: true` → `exposure: "direct"` (an explicit `exposure` wins)
 *   - `description` passes through to pi (it feeds the `mcp_servers` prompt section and tool search)
 *
 * Tool usage is never configured here. It is the protocol data each server declares itself: the
 * tool `description` and `inputSchema` from `tools/list`, and the server `instructions` from
 * `initialize`. pi declares an MCP tool only once its server connects, and the model meets it
 * without context, so this adapter renders that same protocol data where the model plans: the
 * `mcp_usage` system prompt section, the call proxy description, and call errors — verbatim,
 * never rewritten.
 *
 * Query hygiene: a model in a hurry pastes the user's request into a query parameter and the
 * search runs on the raw sentence. A `tool_call` guard detects that (a verbatim copy — or a
 * near-complete excerpt — of the prompt, or request framing such as "帮我查…") and blocks the
 * call with the fix; the parameter's
 * own schema description decides what it wants, so a parameter that asks for the user's question
 * is left alone. A blocked call may be repeated once unchanged, so a deliberate pass goes through.
 *   - `url`, `headers`, `env`, `cwd`, `oauth`, `enabled`, `timeout`, `toolExposure`,
 *     and `exposure` pass through unchanged, so `${NAME}` and `!command` references
 *     in `headers`/`env` are resolved by pi as usual
 *
 * Project entries replace global entries with the same name, and a server of the
 * same name in `mcp.json` takes precedence over both (see `/mcp`).
 *
 * Startup behavior: pi makes the first prompt wait for the MCP startup connections (at most 10
 * seconds), which delays the first message when a server connects slowly. The top-level
 * `startupWait` key controls this:
 *
 *   { "startupWait": false, "mcpServers": { ... } }
 *
 *   - unset (default): `true` automatically when any server exposes a `direct` tool (those must be
 *     declared in the first request, so the first prompt waits for the connection, at most 10
 *     seconds), `false` otherwise.
 *   - `false`: the servers register when the first turn starts (so the first message is recorded
 *     and displayed without waiting) and connect in the background. Their tools become available
 *     as soon as they connect; until then the call proxies cover them.
 *   - `true`: the servers join pi's startup connections, so the first prompt waits for them
 *     (shorter when they connect quickly) and can use their tools right away.
 *
 * Call-time waiting: while a server is still connecting, its tools can already be called through
 * the `mcp_call__<server>` call proxy this extension registers for it. The proxy lists the tools
 * it knows for the server (from `~/.pi/agent/mcp-adapter-tools.json`, which it fills itself, and
 * the `mcp-cache.json` older pi versions kept); a call waits for the connection (at most
 * `readyTimeout` seconds, default 120) and then executes the real tool and returns its result.
 * Calling the proxy with `tool: "__list__"` waits for the connection and returns the server's
 * tool list, so nothing is needed up front. Once the server is connected its own
 * `mcp__<server>__<tool>` tools are declared and should be preferred.
 *
 * Error handling: failures are classified. Transient ones (network problems, timeouts, 5xx,
 * rate limits) are retried up to `retries` times (default 3) with growing delays (`retryDelay`
 * seconds, doubling, default 2); a recovered call returns the real result unchanged so the model
 * continues its unfinished reasoning. Definitive failures (auth, bad request, unknown tool) and
 * transient failures that retries did not fix are reported to the model with the error class, the
 * original error, and how to help the user troubleshoot and fix it.
 *
 *   { "startupWait": false, "readyTimeout": 120, "retries": 3, "retryDelay": 2, "mcpServers": { ... } }
 *
 * Commands:
 *   /mcp-adapter           show configured servers and how they were mapped
 *   /mcp-adapter reload    re-read the files and update this session's registrations
 *
 * Loaded automatically from .pi/extensions/. After editing, run /reload in pi.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	McpExposure,
	McpServerConfig,
	ToolDefinition,
	ToolExposure,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

// ---------------------------------------------------------------- config files

/** Where the adapter reads its config from. Global first, project overrides by name. */
export function adapterConfigPaths(cwd: string): { global: string; project: string } {
	return {
		global: join(homedir(), ".pi", "agent", "mcp-adapter.json"),
		project: join(cwd, ".pi", "mcp-adapter.json"),
	};
}

/**
 * Exposure values including `codemode-deferred`: pi 0.99 defines it, pi 1.1 keeps it as an alias.
 * It is accepted in the config on both and passed through to pi as written.
 */
export type AdapterExposure = "codemode" | "codemode-deferred" | "deferred" | "direct" | "hidden";

const EXPOSURES: readonly AdapterExposure[] = [
	"codemode",
	"codemode-deferred",
	"deferred",
	"direct",
	"hidden",
];
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const HTTP_TYPES = new Set(["remote", "http", "https", "sse", "url", "streamable-http", "streamable_http"]);
const STDIO_TYPES = new Set(["local", "stdio", "subprocess", "process", "command", "cli"]);

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;
/** How long a call proxy waits for its server before giving up (seconds). */
const READY_TIMEOUT_DEFAULT = 120;
/** Extra attempts for errors that look transient (a call fails once by default). */
const RETRIES_DEFAULT = 3;
/** Seconds before the first retry; every further retry doubles it. */
const RETRY_DELAY_DEFAULT = 2;

// ------------------------------------------------------- error classification

export interface ErrorKind {
	/** What kind of failure this is, for the model and the user. */
	name: string;
	/** Whether another attempt can plausibly succeed. */
	retryable: boolean;
	/** How the model can help the user fix it. */
	advice: string;
}

/**
 * Classes of MCP call failures. Order matters: the first matching pattern wins, so specific
 * classes (auth, not-found) come before the broad transport patterns.
 */
const ERROR_KINDS: Array<{ name: string; retryable: boolean; advice: string; pattern: RegExp }> = [
	{
		name: "rate-limit",
		retryable: true,
		advice: "The server or the service behind it is rate limiting. Wait a bit or reduce the call rate.",
		pattern: /\b429\b|too many requests|rate ?limit|quota|throttl/i,
	},
	{
		name: "auth",
		retryable: false,
		advice:
			"The server rejected the credentials. Check the Authorization header (or `oauth`) of this server in .pi/mcp-adapter.json or ~/.pi/agent/mcp-adapter.json — or, for OAuth servers, run /mcp login <server> — then retry the call.",
		pattern: /\b401\b|\b403\b|unauthorized|forbidden|access denied|invalid.?(api.?key|token|credential|key)|authentication|not authenticated|needs? sign-?in/i,
	},
	{
		name: "not-found",
		retryable: false,
		advice:
			"The tool or resource does not exist on the server. Check the name against the server's tool list (call the proxy with tool=\"__list__\") and fix the call or the server configuration.",
		pattern: /\b404\b|not found|unknown tool|no such tool|unreachable tool|withdrawn/i,
	},
	{
		name: "bad-request",
		retryable: false,
		advice: "The server rejected the request. Check the call's arguments against the tool's input schema and correct them.",
		pattern: /\b400\b|\b422\b|invalid|missing|required|malformed|schema|validation/i,
	},
	{
		name: "server",
		retryable: true,
		advice: "The server reported an internal error. If it persists, check the service behind the MCP server.",
		pattern: /\b50[02348]\b|internal server error|bad gateway|service unavailable|overloaded/i,
	},
	{
		name: "network",
		retryable: true,
		advice: "A transport problem between this machine and the server. Check that the server URL is reachable and stable.",
		// Only JSON *parse* failures (truncated/HTML response bodies) count as transport here;
		// a bare "JSON" in the text is far too broad — server-side argument complaints like
		// "expected JSON object" would get retried as transient network errors.
		pattern:
			/fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network|timed? ?out|timeout|deadline exceeded|connection (reset|refused|closed|aborted)|disconnected|temporarily|unavailable|unexpected end|is not valid JSON|unexpected token|JSON parse/i,
	},
];

/** Classify a failed MCP call from its error text. Unknown errors are not retried. */
export function classifyError(text: string): ErrorKind {
	for (const kind of ERROR_KINDS) {
		if (kind.pattern.test(text)) return { name: kind.name, retryable: kind.retryable, advice: kind.advice };
	}
	return {
		name: "unknown",
		retryable: false,
		advice: "Inspect the error with the user, check the server configuration and the /mcp connection state.",
	};
}

/** Text of a failed tool outcome, from its content blocks. */
export function errorTextOf(outcome: { result?: { content?: unknown } }): string {
	const content = outcome.result?.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

export interface CallFailure {
	server: string;
	tool: string;
	attempts: number;
	elapsedMs: number;
	kind: ErrorKind;
	error: string;
	/** True when the error looked transient but the retries did not help. */
	exhausted: boolean;
	/** The tool's declared inputSchema summary (`tools/list`), when known. */
	expectedArgs?: string;
}

/**
 * Error reported to the model for an unrecoverable failure (or retries that did not help):
 * what failed, why, and how the model can help the user fix it.
 */
export function formatCallError(failure: CallFailure): string {
	const { server, tool, attempts, elapsedMs, kind, error, exhausted } = failure;
	const elapsed = `${(elapsedMs / 1000).toFixed(1)}s`;
	const head = exhausted
		? `MCP call failed (server "${server}", tool "${tool}") after ${attempts} attempt${attempts === 1 ? "" : "s"} over ${elapsed}. The error looked transient but the retries did not help; treat it as unrecoverable.`
		: `MCP call failed (server "${server}", tool "${tool}", attempt ${attempts} after ${elapsed}). This error is not recoverable by retrying.`;
	return [
		head,
		`Error class: ${kind.name}.`,
		`Error: ${error || "unknown error"}`,
		...(failure.expectedArgs ? [`Expected arguments (from the tool's inputSchema): ${failure.expectedArgs}`] : []),
		`Help the user troubleshoot and fix it: ${kind.advice}`,
		`Diagnostics: /mcp shows the connection state, /mcp-adapter lists the configured servers.`,
	].join("\n");
}

type RawEntry = Record<string, unknown>;

// ---------------------------------------------------------------- call proxies

/** A tool entry as pi last saw it, from `~/.pi/agent/mcp-cache.json`. */
export interface CachedTool {
	name: string;
	description: string;
	inputSchema?: unknown;
}

/**
 * Tool lists of MCP servers as pi cached them after connecting. Used to describe the call
 * proxies before their servers connect; a missing cache only means the proxies list no tools.
 */
function parseToolCache(parsed: unknown): Map<string, CachedTool[]> {
	const cache = new Map<string, CachedTool[]>();
	if (!isRecord(parsed) || !isRecord(parsed.servers)) return cache;
	for (const [server, value] of Object.entries(parsed.servers)) {
		if (!isRecord(value) || !Array.isArray(value.tools)) continue;
		const tools: CachedTool[] = [];
		for (const tool of value.tools) {
			if (isRecord(tool) && typeof tool.name === "string") {
				tools.push({
					name: tool.name,
					description: typeof tool.description === "string" ? tool.description : "",
					inputSchema: tool.inputSchema,
				});
			}
		}
		cache.set(server, tools);
	}
	return cache;
}

function readToolCacheFile(path: string): Map<string, CachedTool[]> {
	try {
		return parseToolCache(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return new Map();
	}
}

/** Tool lists pi cached after connecting (kept by pi versions before 1.1). */
export function loadToolCache(): Map<string, CachedTool[]> {
	return readToolCacheFile(join(homedir(), ".pi", "agent", "mcp-cache.json"));
}

/** Tool lists this extension observed itself (`~/.pi/agent/mcp-adapter-tools.json`). */
export function loadOwnToolCache(): Map<string, CachedTool[]> {
	return readToolCacheFile(join(homedir(), ".pi", "agent", "mcp-adapter-tools.json"));
}

/**
 * Remember the tools of one server, merging with what is already saved.
 *
 * Concurrency: several pi processes may persist at once. The rename is atomic, but the
 * read-merge-write sequence is not — a write that races another process's write wins wholesale
 * and drops the other's newly listed tools (last writer wins). Best effort by design: the cache
 * only enriches what the call proxy can list up front, and the live `tools/list` remains the
 * source of truth once the server connects.
 */
export function persistServerTools(server: string, tools: CachedTool[]): void {
	try {
		const path = join(homedir(), ".pi", "agent", "mcp-adapter-tools.json");
		let root: RawEntry = {};
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (isRecord(parsed)) root = parsed;
		} catch {
			// No cache yet: start one.
		}
		const servers: RawEntry = isRecord(root.servers) ? { ...root.servers } : {};
		const merged = new Map<string, CachedTool>();
		for (const tool of parseToolCache({ servers: { [server]: servers[server] } }).get(server) ?? []) {
			merged.set(tool.name, tool);
		}
		for (const tool of tools) merged.set(tool.name, tool);
		servers[server] = { tools: [...merged.values()] };
		const tmp = `${path}.${process.pid}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify({ ...root, version: 1, servers }, null, 1), { mode: 0o600 });
			renameSync(tmp, path);
		} catch (error) {
			// A failed rename must not leave the temp file behind (a stale `<path>.<pid>.tmp`
			// accumulating in ~/.pi/agent); the outer catch swallows the failure.
			try {
				rmSync(tmp, { force: true });
			} catch {
				// Best effort.
			}
			throw error;
		}
	} catch {
		// Best effort: the cache only enriches what the call proxy can list up front.
	}
}

/** Merge cached tool lists; later lists win per tool name. */
export function mergeCachedTools(...lists: (CachedTool[] | undefined)[]): CachedTool[] {
	const merged = new Map<string, CachedTool>();
	for (const list of lists) {
		for (const tool of list ?? []) merged.set(tool.name, tool);
	}
	return [...merged.values()];
}

/**
 * The name pi gives a tool once its server connects: `mcp__<server>__<tool>`, sanitized and
 * shortened with a hash suffix when over 64 characters (pi's `createMcpToolName`). pi 1.1
 * replaces `-` with `_` (`mcp__web_search__search_pro`), pi 0.99 keeps it
 * (`mcp__web-search__search_pro`); {@link mcpToolNames} lists both.
 */
export function mcpToolName(server: string, tool: string): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/** Every name pi may give the tool: both the pi 1.1 and the pi 0.99 naming scheme. */
export function mcpToolNames(server: string, tool: string): string[] {
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	const shorten = (name: string) => {
		if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
		return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
	};
	// pi hash-shortens not only over-long names but also names whose sanitized form collides
	// with another tool of the server (its `isTaken` check), so `<name>_<hash>` exists even for
	// short names. The hashed forms come first: when the plain form is taken by a colliding
	// tool, a call by the server-side name must resolve to the hash-renamed one.
	const hashed = (name: string) => `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
	const plain = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	const dashed = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
	return [...new Set([hashed(plain), hashed(dashed), shorten(plain), shorten(dashed)])];
}

/** Namespaces of a server's tools on both pi versions: `mcp__<server>`, `-` kept or replaced by `_`. */
export function namespaceNames(server: string): string[] {
	return [...new Set([`mcp__${server}`, `mcp__${server.replace(/-/g, "_")}`])];
}

/**
 * The tool's own name: its registered name without the `mcp__<server>__` prefix. A
 * hash-shortened registered name keeps its `_<hash>` suffix (or the whole registered name,
 * when shortening ate into the prefix itself); the original name is not recoverable.
 */
function rawToolName(entry: { name: string; namespace?: { name: string } }): string {
	const prefix = `${entry.namespace?.name ?? ""}__`;
	return entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : entry.name;
}

/** Name of the call proxy that stands in for a server's tools while it connects. */
export function proxyToolName(server: string): string {
	const name = `mcp_call__${server}`;
	if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
	const hash = createHash("sha256").update(server).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function patternMatches(pattern: string, value: string): boolean {
	const parts = pattern.split("*");
	if (parts.length === 1) return pattern === value;
	const head = parts[0] ?? "";
	const tail = parts[parts.length - 1] ?? "";
	if (!value.startsWith(head) || !value.endsWith(tail)) return false;
	let index = head.length;
	for (const part of parts.slice(1, -1)) {
		const at = part ? value.indexOf(part, index) : index;
		if (at < 0) return false;
		index = at + part.length;
	}
	return true;
}

/** Exposure of one tool: its `toolExposure` entry (exact name wins, then the first pattern), else the server's. */
export function effectiveToolExposure(config: McpServerConfig, toolName: string): AdapterExposure {
	const overrides = config.toolExposure;
	if (overrides) {
		const exact = overrides[toolName];
		if (exact) return exact as AdapterExposure;
		for (const [pattern, exposure] of Object.entries(overrides)) {
			if (!pattern.includes("*")) continue;
			if (patternMatches(pattern, toolName)) return exposure as AdapterExposure;
		}
	}
	return (config.exposure ?? "codemode") as AdapterExposure;
}

/** `codemode-deferred` tools are not listed in the codemode description; pi reaches them with tool_search. */
function toToolExposure(exposure: string): ToolExposure {
	return (exposure === "codemode-deferred" ? "deferred" : exposure) as ToolExposure;
}

export interface ProxyOptions {
	server: string;
	config: McpServerConfig;
	cachedTools: CachedTool[];
	/** Seconds a call waits for the connection before giving up. */
	readyTimeout: number;
	/** Extra attempts for transient errors. */
	retries: number;
	/** Seconds before the first retry; doubles every further retry. */
	retryDelay: number;
	pi: ExtensionAPI;
}

/**
 * The call proxy for one server: declared before the server connects, a call waits for the
 * connection and then executes the real tool. The name never collides with the server's own
 * `mcp__<server>__<tool>` tools, which pi registers on connect (a same-named tool registered by
 * an extension would shadow them for good).
 */
/** Compact parameter summary of a tool's input schema: `query (string, required), topN (integer)`. */
export function summarizeParameters(inputSchema: unknown): string {
	if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)) return "";
	const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
	return Object.entries(inputSchema.properties)
		.map(([param, spec]) => {
			const type = isRecord(spec) && typeof spec.type === "string" ? spec.type : "unknown";
			// The property's own description is the server's usage text; render it verbatim.
			const desc = isRecord(spec) && typeof spec.description === "string" ? spec.description : "";
			return `${param} (${type}${required.includes(param) ? ", required" : ""})${desc ? `: ${desc}` : ""}`;
		})
		.join("; ");
}

// ------------------------------------------------------------- query hygiene

/** Parameter names whose value is a search query rather than free text. */
const QUERY_PARAM_PATTERN = /^(query|q|search|search_query|searchQuery|search_term|searchTerm|search_text|searchText|keywords?|terms?)$/i;

/** A schema description that explicitly asks for the user's own words, where pasting is correct. */
const WANTS_QUESTION_PATTERN = /用户(的)?(问题|提问|原话|输入|描述)|user'?s? (question|request|prompt|input)|natural-language question/i;

/** Request framing that only appears when the raw request was pasted into a query parameter. */
const REQUEST_FRAME_PATTERN = /^(帮我|麻烦你|麻烦帮|请帮|请你帮|我想知道|我想了解|我想问|能不能帮我|可不可以|可以帮我|请问一下|告诉我|帮个忙)/;
const REQUEST_INLINE_PATTERN = /帮我(查|搜|找|看|了解)/;

/** Whitespace- and punctuation-insensitive compare, so a verbatim paste still matches. */
export function normalizeForCompare(value: string): string {
	return value.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
}

/** Whether a query-parameter value is the user's request text rather than distilled search terms. */
export function looksLikeRawRequest(value: string, prompt: string | undefined): boolean {
	const text = value.trim();
	if (text.length < 4) return false;
	if (prompt) {
		const a = normalizeForCompare(text);
		const b = normalizeForCompare(prompt);
		const covered = b.includes(a) && a.length / b.length >= 0.6;
		if (a.length >= 6 && (a === b || (b.length >= 6 && a.includes(b)) || covered)) return true;
	}
	return REQUEST_FRAME_PATTERN.test(text) || REQUEST_INLINE_PATTERN.test(text);
}

export interface QueryOffense {
	/** Dotted path of the offending parameter, e.g. `arguments.query`. */
	path: string;
	value: string;
	/** The parameter's own schema description, when the call exposes one. */
	paramDesc?: string;
}

/**
 * Query-like parameters whose value is the user's request text instead of search terms.
 * `nestedSchema` describes the `arguments`/`params` sub-object when the call names another tool
 * (the call proxy and `call_tool`-style meta tools), so that tool's own description is honored.
 */
export function findRawRequestParams(
	input: unknown,
	schema: unknown,
	prompt: string | undefined,
	nestedSchema?: unknown,
	prefix = "",
	depth = 0,
): QueryOffense[] {
	const found: QueryOffense[] = [];
	if (depth > 3 || !isRecord(input)) return found;
	const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined;
	for (const [key, value] of Object.entries(input)) {
		const path = prefix ? `${prefix}.${key}` : key;
		const spec = properties?.[key];
		const paramDesc = isRecord(spec) && typeof spec.description === "string" ? spec.description : undefined;
		if (typeof value === "string") {
			if (!QUERY_PARAM_PATTERN.test(key)) continue;
			if (paramDesc && WANTS_QUESTION_PATTERN.test(paramDesc)) continue;
			if (looksLikeRawRequest(value, prompt)) found.push({ path, value, paramDesc });
		} else if (isRecord(value)) {
			const childSchema = depth === 0 && (key === "arguments" || key === "params") ? nestedSchema : undefined;
			found.push(...findRawRequestParams(value, childSchema, prompt, undefined, path, depth + 1));
		}
	}
	return found;
}

/** Best-effort inputSchema of a raw tool name across the cached server tool lists. */
export function lookupCachedInputSchema(rawToolName: string): unknown {
	for (const cache of [loadOwnToolCache(), loadToolCache()]) {
		for (const tools of cache.values()) {
			const tool = tools.find((candidate) => candidate.name === rawToolName);
			if (tool?.inputSchema) return tool.inputSchema;
		}
	}
	return undefined;
}

/** Blocked call report: what was wrong and how to rewrite the parameters. */
export function formatQueryGuardReason(toolName: string, path: string, value: string, paramDesc?: string): string {
	return [
		`MCP call blocked before it ran (nothing executed): "${path}" of ${toolName} holds the user's request text, not search terms.`,
		`Got: ${value.length > 120 ? `${value.slice(0, 120)}…` : value}`,
		...(paramDesc ? [`The parameter's schema says it wants: ${paramDesc}`] : []),
		`Rewrite the call: distill the request into search keywords — its entities and intent, e.g. "帮我查一下北京明天的天气" → "北京 天气" — and pass only those as "${path}".`,
		`Pass the user's question text only where the parameter's description asks for it.`,
		`Call the tool again with the corrected parameters.`,
	].join("\n");
}

export function createProxyDefinition(options: ProxyOptions): ToolDefinition {
	const { server, config, cachedTools, readyTimeout, retries, retryDelay, pi } = options;
	const name = proxyToolName(server);
	const namespaces = namespaceNames(server);
	const listed = cachedTools
		.map((tool) => {
			const params = summarizeParameters(tool.inputSchema);
			const head = `- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`;
			return params ? `${head}\n    params: ${params}` : head;
		})
		.join("\n");
	const description = [
		`Call a tool of the MCP server "${server}". Use it as soon as the task needs this server; the call waits for the connection, so it works even before the server's own tools are declared.`,
		`"tool" names the MCP tool of "${server}" and "arguments" is that tool's arguments object; take both from the known tool list below (or from tool="__list__") and never invent them.`,
		`It waits (up to ${readyTimeout} seconds) until the server is connected, then executes the real tool and returns its result.`,
		`Transient failures (network problems, timeouts, 5xx, rate limits) are retried up to ${retries} times with growing delays before the error is reported.`,
		`Once the server's own tools (namespace ${namespaces.join(" or ")}) are declared, prefer them over this proxy.`,
		`Calling with tool="__list__" waits for the connection and returns the server's current tool list.`,
		listed ? `Known tools (name: server description; params: server inputSchema):\n${listed}` : `The server's tool list is not known yet; discover it with tool="__list__".`,
	].join("\n");
	const parameters = {
		type: "object",
		properties: {
			tool: {
				type: "string",
				description: `Name of the MCP tool of "${server}" to call, for example "${cachedTools[0]?.name ?? "tool_name"}". Use "__list__" to discover the server's tools.`,
			},
			arguments: { type: "object", description: "Arguments for the tool call." },
		},
		additionalProperties: false,
	};
	const definition = {
		name,
		label: `mcp call (${server})`,
		description,
		promptSnippet: `call MCP tools of "${server}" (waits for the connection; tool="__list__" lists them)`,
		promptGuidelines: [
			`MCP server "${server}" offers tools; when the task matches, call them proactively instead of assuming they are unavailable.`,
		],
		parameters,
		exposure: toToolExposure(config.exposure ?? "codemode"),
		namespace: { name: namespaces[0] ?? `mcp__${server}`, description: `Tools of the MCP server "${server}".` },
		async execute(
			_toolCallId: string,
			params: { tool?: string; arguments?: Record<string, unknown> },
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionToolContext,
		): Promise<AgentToolResult> {
			const tool = typeof params?.tool === "string" ? params.tool.trim() : "";
			const wantsList = !tool || tool === "__list__";
			const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
			const candidates = wantsList ? [] : mcpToolNames(server, tool);
			const rawName = rawToolName;
			const deadline = Date.now() + readyTimeout * 1000;
			let target: string | undefined;
			for (;;) {
				// The proxy shares the server's namespace, so it must not count as a server tool.
				const inNamespace = pi
					.getAllTools()
					.filter(
						(entry) =>
							entry.namespace?.name !== undefined &&
							namespaces.includes(entry.namespace.name) &&
							entry.name !== name &&
							!entry.name.startsWith("mcp_call__"),
					);
				target = candidates.find((candidate) => inNamespace.some((entry) => entry.name === candidate));
				if (target === undefined) {
					// A hash-shortened registered name does not round-trip through mcpToolNames:
					// the listed name is the registered one minus its namespace (see rawToolName).
					// Accept that name back as-is.
					const listed = inNamespace.find((entry) => rawToolName(entry) === tool);
					if (listed) target = listed.name;
				}
				const ready = wantsList ? inNamespace.length > 0 : target !== undefined;
				if (ready) {
					// Remember the live tools so the next session can list them right away.
					persistServerTools(
						server,
						inNamespace.map((entry) => ({
							name: rawName(entry),
							description: entry.description,
							inputSchema: entry.parameters,
						})),
					);
					if (wantsList) {
						const list = inNamespace
							.map((entry) => `${rawName(entry)}${entry.description ? `: ${entry.description}` : ""}`)
							.join("\n");
						return {
							content: [{ type: "text", text: list || `MCP server "${server}" is connected but offers no tools.` }],
							details: { server, listed: true },
						};
					}
					break;
				}
				if (!wantsList && inNamespace.length > 0) {
					const available = inNamespace.map(rawName).join(", ");
					throw new Error(
						`MCP call failed (server "${server}", tool "${tool}"). This error is not recoverable by retrying.\n` +
							`Error class: not-found.\n` +
							`Error: the server does not offer a tool named "${tool}". Available: ${available}\n` +
							`Help the user troubleshoot and fix it: check the tool name against the list above and correct the call or the server configuration.`,
					);
				}
				if (signal?.aborted) throw new Error(`Stopped waiting for MCP server "${server}".`);
				if (Date.now() >= deadline) {
					const endpoint = "url" in config ? config.url : [config.command, ...(config.args ?? [])].join(" ");
					throw new Error(
						`MCP call not made: server "${server}" is still connecting after ${readyTimeout}s, so "${tool || "__list__"}" was not executed (nothing ran; calling again is safe).\n` +
							`Error class: timeout.\n` +
							`Help the user troubleshoot and fix it: check that ${endpoint} is reachable and the credentials are valid (/mcp shows the connection state), raise "readyTimeout" in .pi/mcp-adapter.json if the server is only slow, and for loopback servers make sure NO_PROXY covers their address (name-based "localhost" is safer than an IP in a CIDR range).`,
					);
				}
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			// Retry transient failures with backoff. A success returns the real tool's result as-is,
			// so the model continues its unfinished reasoning; failures become structured errors the
			// model can use to help the user.
			const startedAt = Date.now();
			const maxAttempts = 1 + Math.max(0, retries);
			for (let attempt = 1; ; attempt++) {
				let result: AgentToolResult | undefined;
				let errorText = "";
				try {
					const outcome = await ctx.executeTool(target as string, args, { signal });
					if (outcome.isError) errorText = errorTextOf(outcome) || "unknown error";
					else result = (outcome.result as AgentToolResult | undefined) ?? { content: [], details: {} };
				} catch (error) {
					errorText = error instanceof Error ? error.message : String(error);
				}
				if (result) {
					return {
						content: result.content ?? [],
						details: ((result.details as unknown) ?? {}) as AgentToolResult["details"],
					};
				}
				const kind = classifyError(errorText);
				const canRetry = kind.retryable && attempt < maxAttempts;
				if (!canRetry) {
					throw new Error(
						formatCallError({
							server,
							tool,
							attempts: attempt,
							elapsedMs: Date.now() - startedAt,
							kind,
							error: errorText,
							exhausted: kind.retryable,
							expectedArgs:
								summarizeParameters(
									pi.getAllTools().find((entry) => entry.name === target)?.parameters ??
										cachedTools.find((cached) => cached.name === tool)?.inputSchema,
								) || undefined,
						}),
					);
				}
				// Exponential backoff between attempts, capped at 30 seconds.
				const waitMs = Math.min(retryDelay * 1000 * 2 ** (attempt - 1), 30_000);
				await new Promise<void>((resolve, reject) => {
					const stop = () => reject(new Error(`Stopped waiting for MCP server "${server}".`));
					// Pre-check: an already-aborted signal never fires a fresh 'abort' event, so without
					// this the wait would sleep out the full backoff after the caller gave up.
					if (signal?.aborted) {
						stop();
						return;
					}
					let timer: ReturnType<typeof setTimeout>;
					const onAbort = () => {
						clearTimeout(timer);
						stop();
					};
					timer = setTimeout(() => {
						signal?.removeEventListener("abort", onAbort);
						resolve();
					}, waitMs);
					signal?.addEventListener("abort", onAbort, { once: true });
				});
			}
		},
	};
	return definition as unknown as ToolDefinition;
}

export interface AdapterEntry {
	/** Server name as written in the config file. */
	name: string;
	/** Translated pi config, when the entry is valid. */
	config?: McpServerConfig;
	/** Why the entry was skipped. */
	error?: string;
	/** Fields the adapter translated, shown by /mcp-adapter. */
	compat: string[];
	/** File that defined the entry. */
	source: string;
	/** Whether the project file defines it (it then replaces the global entry). */
	scope: "global" | "project";
}

export interface AdapterLoadResult {
	entries: AdapterEntry[];
	errors: string[];
	/** Whether the first prompt should wait for the connections (`startupWait`). */
	startupWait: boolean;
	/** Where the value came from: the config, or the default (automatic for direct tools). */
	startupWaitSource: "config" | "auto-direct" | "default";
	/** Seconds a call proxy waits for its server before giving up (`readyTimeout`). Default: 120. */
	readyTimeout: number;
	/** Extra attempts for transient errors (`retries`). Default: 3. */
	retries: number;
	/** Seconds before the first retry, doubling per attempt (`retryDelay`). Default: 2. */
	retryDelay: number;
}

function isRecord(value: unknown): value is RawEntry {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Split a shell-style string into words, honoring simple quotes. */
function splitArgs(value: string): string[] {
	const words: string[] = [];
	const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(value)) !== null) {
		words.push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return words;
}

function stringMap(value: unknown): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error("must be an object of string values");
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") throw new Error(`"${key}" must be a string`);
		out[key] = item;
	}
	return out;
}

/** `exposure` wins; else `directTools: true` maps to direct exposure. */
function resolveExposure(raw: RawEntry, compat: string[]): AdapterExposure | { error: string } | undefined {
	const exposure = raw.exposure;
	if (exposure !== undefined) {
		if (typeof exposure === "string" && (EXPOSURES as readonly string[]).includes(exposure)) {
			return exposure as AdapterExposure;
		}
		return { error: `invalid exposure "${String(exposure)}" (expected ${EXPOSURES.join(", ")})` };
	}
	if (typeof raw.directTools === "boolean") {
		if (raw.directTools) {
			compat.push("directTools: true → exposure: direct");
			return "direct";
		}
		compat.push("directTools: false → default exposure (codemode)");
		return undefined;
	}
	return undefined;
}

/** Translate one config entry to pi's mcpServers shape. */
export function normalizeEntry(name: string, raw: unknown, source: string): AdapterEntry {
	const compat: string[] = [];
	const entry = (extra: Partial<AdapterEntry>): AdapterEntry => ({ name, compat, source, scope: "project", ...extra });

	if (!isRecord(raw)) return entry({ error: "entry must be an object" });
	if (!NAME_PATTERN.test(name)) {
		return entry({ error: "name may only contain letters, digits, '_' and '-'" });
	}

	// Older configs may carry hand-written usage notes. Tool usage is protocol data (each tool's
	// description and inputSchema from tools/list), so these are ignored rather than trusted.
	if (raw.usage !== undefined || raw.toolHints !== undefined) {
		compat.push("usage/toolHints: ignored — tool usage comes from the server's tools/list response");
	}

	const type = typeof raw.type === "string" ? raw.type.toLowerCase() : undefined;
	if (type !== undefined && !HTTP_TYPES.has(type) && !STDIO_TYPES.has(type)) {
		return entry({ error: `unknown type "${String(raw.type)}" (expected remote/http or local/stdio)` });
	}

	const hasUrl = typeof raw.url === "string" && raw.url.length > 0;
	const hasCommand = raw.command !== undefined;
	let transport: "http" | "stdio" | undefined;
	if (type !== undefined && HTTP_TYPES.has(type)) transport = "http";
	else if (type !== undefined && STDIO_TYPES.has(type)) transport = "stdio";
	else if (hasUrl && !hasCommand) transport = "http";
	else if (hasCommand && !hasUrl) transport = "stdio";
	else if (!hasUrl && !hasCommand) return entry({ error: "entry needs a 'url' or a 'command'" });
	else return entry({ error: "entry has both 'url' and 'command'; set 'type' to remote or local" });

	if (type !== undefined && type !== transport && !(transport === "http" && type === "streamable-http")) {
		compat.push(`type: ${String(raw.type)} → ${transport}`);
	}

	const exposure = resolveExposure(raw, compat);
	if (exposure !== undefined && typeof exposure === "object") return entry({ error: exposure.error });

	try {
		// Fields shared by both transports.
		const base: {
			description?: string;
			exposure?: AdapterExposure;
			toolExposure?: Record<string, AdapterExposure>;
			enabled?: boolean;
			timeout?: number;
		} = {};
		if (exposure !== undefined) base.exposure = exposure;
		if (raw.description !== undefined) {
			if (typeof raw.description !== "string") return entry({ error: "'description' must be a string" });
			base.description = raw.description;
		}
		if (raw.enabled !== undefined) {
			if (typeof raw.enabled !== "boolean") return entry({ error: "'enabled' must be a boolean" });
			base.enabled = raw.enabled;
		}
		if (raw.timeout !== undefined) {
			if (typeof raw.timeout !== "number" || !(raw.timeout > 0)) {
				return entry({ error: "'timeout' must be a positive number of seconds" });
			}
			base.timeout = raw.timeout;
		}
		if (raw.toolExposure !== undefined) {
			if (!isRecord(raw.toolExposure)) return entry({ error: "'toolExposure' must be an object" });
			const toolExposure: Record<string, AdapterExposure> = {};
			for (const [tool, value] of Object.entries(raw.toolExposure)) {
				if (typeof value === "string" && (EXPOSURES as readonly string[]).includes(value)) {
					toolExposure[tool] = value as AdapterExposure;
				} else {
					compat.push(`toolExposure[${tool}]: ignored invalid exposure "${String(value)}"`);
				}
			}
			base.toolExposure = toolExposure;
		}

		if (transport === "http") {
			if (!hasUrl) return entry({ error: "HTTP server needs a 'url'" });
			const headers = stringMap(raw.headers);
			let oauth: Record<string, unknown> | undefined;
			if (raw.oauth !== undefined) {
				if (!isRecord(raw.oauth)) return entry({ error: "'oauth' must be an object" });
				oauth = raw.oauth;
			}
			const config = {
				url: raw.url as string,
				...(headers ? { headers } : {}),
				...(oauth ? { oauth: oauth as never } : {}),
				...base,
			} as unknown as McpServerConfig;
			return entry({ config });
		}

		// stdio
		let command: string;
		let extraArgs: string[] = [];
		if (Array.isArray(raw.command)) {
			const parts = raw.command;
			if (parts.length === 0 || parts.some((part) => typeof part !== "string")) {
				return entry({ error: "'command' array must contain strings" });
			}
			command = parts[0] as string;
			extraArgs = parts.slice(1) as string[];
			compat.push("command: [...] → command + args");
		} else if (typeof raw.command === "string") {
			command = raw.command;
		} else {
			return entry({ error: "stdio server needs a 'command'" });
		}

		let args: string[] = extraArgs;
		if (raw.args !== undefined) {
			if (Array.isArray(raw.args)) {
				if (raw.args.some((part) => typeof part !== "string")) {
					return entry({ error: "'args' must contain strings" });
				}
				args = [...args, ...(raw.args as string[])];
			} else if (typeof raw.args === "string") {
				args = [...args, ...splitArgs(raw.args)];
				compat.push("args: \"...\" → args: [...]");
			} else {
				return entry({ error: "'args' must be a string or an array of strings" });
			}
		}

		let env: Record<string, string> | undefined;
		if (raw.env !== undefined || raw.environment !== undefined) {
			env = stringMap(raw.env ?? raw.environment);
			if (raw.environment !== undefined) compat.push("environment → env");
		}

		const cwd = raw.cwd;
		if (cwd !== undefined && typeof cwd !== "string") return entry({ error: "'cwd' must be a string" });

		const config = {
			command,
			...(args.length > 0 ? { args } : {}),
			...(env ? { env } : {}),
			...(typeof cwd === "string" ? { cwd } : {}),
			...base,
		} as unknown as McpServerConfig;
		return entry({ config });
	} catch (error) {
		return entry({ error: error instanceof Error ? error.message : String(error) });
	}
}

/** Read one adapter file. Missing files are not an error. */
function readAdapterFile(path: string): {
	servers: RawEntry;
	errors: string[];
	startupWait?: boolean;
	readyTimeout?: number;
	retries?: number;
	retryDelay?: number;
} {
	const errors: string[] = [];
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		// A missing file is normal; any other read failure (EACCES, EISDIR, …) is a config problem
		// worth reporting — silently returning zero servers would hide it.
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			errors.push(`${path}: cannot read: ${error instanceof Error ? error.message : String(error)}`);
		}
		return { servers: {}, errors };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { servers: {}, errors: [`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
	}
	if (!isRecord(parsed)) return { servers: {}, errors: [`${path}: top level must be an object`] };
	let startupWait: boolean | undefined;
	if (parsed.startupWait !== undefined) {
		if (typeof parsed.startupWait === "boolean") startupWait = parsed.startupWait;
		else errors.push(`${path}: 'startupWait' must be a boolean`);
	}
	let readyTimeout: number | undefined;
	if (parsed.readyTimeout !== undefined) {
		if (typeof parsed.readyTimeout === "number" && parsed.readyTimeout > 0) readyTimeout = parsed.readyTimeout;
		else errors.push(`${path}: 'readyTimeout' must be a positive number of seconds`);
	}
	let retries: number | undefined;
	if (parsed.retries !== undefined) {
		if (typeof parsed.retries === "number" && Number.isInteger(parsed.retries) && parsed.retries >= 0) retries = parsed.retries;
		else errors.push(`${path}: 'retries' must be a non-negative integer`);
	}
	let retryDelay: number | undefined;
	if (parsed.retryDelay !== undefined) {
		if (typeof parsed.retryDelay === "number" && parsed.retryDelay > 0) retryDelay = parsed.retryDelay;
		else errors.push(`${path}: 'retryDelay' must be a positive number of seconds`);
	}
	// Accept the standard `mcpServers` map (or VS Code's `servers`), or a bare name → entry map.
	const declared = "mcpServers" in parsed ? parsed.mcpServers : "servers" in parsed ? parsed.servers : undefined;
	if (declared !== undefined && !isRecord(declared)) {
		return { servers: {}, errors: [`${path}: 'mcpServers' must be an object`] };
	}
	const bare = declared === undefined;
	const servers: RawEntry = { ...(bare ? parsed : (declared as RawEntry)) };
	if (bare) {
		// Bare map: entries share the top level with the option keys, which are reserved and
		// not servers. Only here may those names be dropped — in the `mcpServers` form a server
		// may legitimately be named `retries`.
		delete servers.startupWait;
		delete servers.readyTimeout;
		delete servers.retries;
		delete servers.retryDelay;
		// Other non-object top-level values ($schema, version, comments) are metadata, not
		// entries — a server entry is always an object, so nothing is lost by skipping them.
		for (const [name, value] of Object.entries(servers)) {
			if (!isRecord(value)) delete servers[name];
		}
	}
	return { servers, errors, startupWait, readyTimeout, retries, retryDelay };
}

/**
 * Load and translate the adapter config. Project entries replace global entries
 * with the same name; entries of untrusted projects are skipped.
 */
export function loadAdapterServers(options: { cwd: string; projectTrusted: boolean }): AdapterLoadResult {
	const paths = adapterConfigPaths(options.cwd);
	const result: AdapterLoadResult = {
		entries: [],
		errors: [],
		startupWait: false,
		startupWaitSource: "default",
		readyTimeout: READY_TIMEOUT_DEFAULT,
		retries: RETRIES_DEFAULT,
		retryDelay: RETRY_DELAY_DEFAULT,
	};
	let startupWaitSet = false;

	const global = readAdapterFile(paths.global);
	result.errors.push(...global.errors);
	if (global.startupWait !== undefined) {
		result.startupWait = global.startupWait;
		startupWaitSet = true;
	}
	if (global.readyTimeout !== undefined) result.readyTimeout = global.readyTimeout;
	if (global.retries !== undefined) result.retries = global.retries;
	if (global.retryDelay !== undefined) result.retryDelay = global.retryDelay;
	for (const [name, raw] of Object.entries(global.servers)) {
		const entry = normalizeEntry(name, raw, paths.global);
		entry.scope = "global";
		result.entries.push(entry);
	}

	if (options.projectTrusted) {
		const project = readAdapterFile(paths.project);
		result.errors.push(...project.errors);
		if (project.startupWait !== undefined) {
			result.startupWait = project.startupWait;
			startupWaitSet = true;
		}
		if (project.readyTimeout !== undefined) result.readyTimeout = project.readyTimeout;
		if (project.retries !== undefined) result.retries = project.retries;
		if (project.retryDelay !== undefined) result.retryDelay = project.retryDelay;
		for (const [name, raw] of Object.entries(project.servers)) {
			const entry = normalizeEntry(name, raw, paths.project);
			entry.scope = "project";
			const index = result.entries.findIndex((other) => other.name === name);
			if (index >= 0) result.entries.splice(index, 1, entry);
			else result.entries.push(entry);
		}
	} else {
		// A project file may exist but is only used once the project is trusted.
		try {
			readFileSync(paths.project, "utf8");
			result.errors.push(`${paths.project}: ignored until the project is trusted (/trust)`);
		} catch {
			// No project file: nothing to ignore.
		}
	}

	// A `direct` tool must be declared in the first request. When its server only connects in the
	// background, the tools arrive mid-conversation — after the model already planned without them,
	// which is exactly how MCP tools get ignored or misused. So any direct tool pulls its server into
	// pi's startup connections (the first prompt waits at most 10s), unless `startupWait` says
	// otherwise explicitly.
	if (startupWaitSet) {
		result.startupWaitSource = "config";
	} else {
		const hasDirect = result.entries.some((entry) => {
			const config = entry.config;
			if (!config || config.enabled === false) return false;
			return (config.exposure ?? "codemode") === "direct" || Object.values(config.toolExposure ?? {}).includes("direct");
		});
		result.startupWait = hasDirect;
		result.startupWaitSource = hasDirect ? "auto-direct" : "default";
	}

	return result;
}

/** Names defined by the `mcp.json` files pi itself reads; those win over adapter entries. */
function mcpJsonNames(cwd: string, projectTrusted: boolean): Set<string> {
	const names = new Set<string>();
	const paths = [join(homedir(), ".pi", "agent", "mcp.json")];
	if (projectTrusted) paths.push(join(cwd, ".pi", "mcp.json"));
	for (const path of paths) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const servers = isRecord(parsed) ? parsed.mcpServers : undefined;
			if (isRecord(servers)) for (const name of Object.keys(servers)) names.add(name);
		} catch {
			// Missing or unreadable: nothing to add.
		}
	}
	return names;
}

// -------------------------------------------------------------------- runtime

interface AdapterState {
	/** name → serialized config of the servers this extension currently registers. */
	registered: Map<string, string>;
	/** Report of the last sync, shown by /mcp-adapter. */
	report: AdapterLoadResult;
	/** Whether the servers were registered. With `startupWait: false` this waits for the first prompt. */
	activated: boolean;
	/** Call proxies this extension registered, by server name. */
	proxyDefinitions: Map<string, ToolDefinition>;
	/** Config+tool fingerprint per server name, so unchanged proxies are not re-registered. */
	proxyKeys: Map<string, string>;
	/** The latest user prompt, used by the query guard to spot a verbatim paste. */
	lastPrompt: string;
	/** Calls the query guard already bounced once; an identical retry is then allowed. */
	guardSeen: Set<string>;
}

/**
 * Register one call proxy per configured server (or refresh it), and withdraw the proxies of
 * servers that disappeared. Proxies carry no connections, so they are fine at session start.
 */
function registerProxies(pi: ExtensionAPI, state: AdapterState, loaded: AdapterLoadResult): void {
	const legacy = loadToolCache();
	const own = loadOwnToolCache();
	const wanted = new Set<string>();
	for (const entry of loaded.entries) {
		const config = entry.config;
		if (!config || config.enabled === false || (config.exposure ?? "codemode") === "hidden") continue;
		wanted.add(entry.name);
		const namespaces = namespaceNames(entry.name);
		const liveTools = pi
			.getAllTools()
			.filter((tool) => tool.namespace?.name !== undefined && namespaces.includes(tool.namespace.name) && !tool.name.startsWith("mcp_call__"))
			.map((tool) => ({
				name: rawToolName(tool),
				description: tool.description,
				inputSchema: tool.parameters,
			}));
		const cachedTools = mergeCachedTools(legacy.get(entry.name), own.get(entry.name), liveTools);
		const key = JSON.stringify([config, cachedTools.map((tool) => tool.name), loaded.readyTimeout, loaded.retries, loaded.retryDelay]);
		if (state.proxyKeys.get(entry.name) === key) continue;
		state.proxyKeys.set(entry.name, key);
		const definition = createProxyDefinition({
			server: entry.name,
			config,
			cachedTools,
			readyTimeout: loaded.readyTimeout,
			retries: loaded.retries,
			retryDelay: loaded.retryDelay,
			pi,
		});
		state.proxyDefinitions.set(entry.name, definition);
		pi.registerTool(definition);
	}
	// Withdraw the proxies of removed servers the way pi withdraws tools: re-register as hidden.
	for (const [server, definition] of [...state.proxyDefinitions]) {
		if (wanted.has(server)) continue;
		pi.registerTool({ ...definition, exposure: "hidden" });
		state.proxyDefinitions.delete(server);
		state.proxyKeys.delete(server);
	}
}

/** Re-read the config files and bring this session's registrations in line. */
function sync(pi: ExtensionAPI, state: AdapterState, ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): AdapterLoadResult {
	const loaded = loadAdapterServers({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
	state.report = loaded;
	registerProxies(pi, state, loaded);

	// With `startupWait: false` the servers must not join pi's startup connections (the first
	// prompt waits for those, up to 10 seconds), so registering them waits for the first prompt.
	if (!loaded.startupWait && !state.activated) return loaded;
	state.activated = true;

	const wanted = new Map<string, AdapterEntry>();
	for (const entry of loaded.entries) {
		if (!entry.config) continue;
		if (!wanted.has(entry.name)) wanted.set(entry.name, entry);
	}

	// Drop servers that disappeared from the config.
	for (const name of [...state.registered.keys()]) {
		if (!wanted.has(name)) {
			try {
				pi.unregisterMcpServer(name);
			} catch {
				// Best effort: host semantics for unknown names are undocumented; a stray
				// throw must not abort the rest of the sync.
			}
			state.registered.delete(name);
		}
	}

	// Register new and changed servers; an unchanged registration is left alone.
	for (const [name, entry] of wanted) {
		const config = entry.config;
		if (!config) continue;
		const serialized = JSON.stringify(config);
		if (state.registered.get(name) === serialized) continue;
		try {
			pi.registerMcpServer(name, config);
			state.registered.set(name, serialized);
		} catch (error) {
			entry.error = error instanceof Error ? error.message : String(error);
			state.registered.delete(name);
		}
	}

	return loaded;
}

function describe(
	report: AdapterLoadResult,
	cwd: string,
	overridden: Set<string>,
	registered: Set<string>,
	tools: Map<string, string[]>,
	proxies: Map<string, ToolDefinition>,
): string[] {
	const lines: string[] = [];
	const shown = report.entries.length;
	lines.push(`mcp-adapter: ${shown} server${shown === 1 ? "" : "s"} registered`);
	lines.push(
		report.startupWait
			? `startupWait: true (${report.startupWaitSource === "config" ? "from config" : "automatic: a server exposes direct tools"}) — the first prompt waits for the connections (max 10s)`
			: `startupWait: false (${report.startupWaitSource === "config" ? "from config" : "default"}) — connects in the background once the first turn starts`,
	);
	lines.push("mcp_usage: injected into the system prompt before every prompt (server capabilities and tool usage)");
	lines.push(`readyTimeout: ${report.readyTimeout}s — a call proxy waits this long for its server`);
	lines.push(`retries: ${report.retries} on transient errors (backoff ${report.retryDelay}s → ${(report.retryDelay * 2).toFixed(0)}s → …)`);
	for (const entry of report.entries) {
		const where = entry.scope === "project" ? "project" : "global";
		const location = relative(cwd, entry.source) || entry.source;
		const config = entry.config;
		const target = config
			? "url" in config
				? `http ${config.url}`
				: `stdio ${config.command}${(config.args ?? []).map((arg) => ` ${arg}`).join("")}`
			: "invalid";
		const exposure = config?.exposure ? `exposure: ${config.exposure}` : "exposure: default (codemode)";
		const serverTools = tools.get(entry.name);
		const toolLine = serverTools
			? serverTools.length > 0
				? `tools: ${serverTools.join(", ")}`
				: "tools: none offered"
			: "tools: none listed (not connected yet, or the server offered none)";
		lines.push(``);
		lines.push(`${entry.name}  [${where}: ${location}]`);
		lines.push(`  ${target}`);
		lines.push(`  ${exposure}${config?.enabled === false ? "  (disabled)" : ""}${registered.has(entry.name) ? "" : "  (not registered)"}`);
		lines.push(`  ${toolLine}`);
		const proxy = proxies.get(entry.name);
		if (proxy) {
			lines.push(`  call proxy: ${proxy.name} — a call waits for the connection, then runs the real tool`);
		}
		if (config && "headers" in config && config.headers) {
			lines.push(`  headers: ${Object.keys(config.headers).join(", ")}`);
		}
		if (config && "env" in config && config.env) {
			lines.push(`  env: ${Object.keys(config.env).join(", ")}`);
		}
		for (const note of entry.compat) lines.push(`  ~ ${note}`);
		if (entry.error) lines.push(`  ! skipped: ${entry.error}`);
		if (overridden.has(entry.name)) lines.push(`  ! overridden by an mcp.json entry of the same name (/mcp)`);
	}
	for (const error of report.errors) {
		lines.push(``);
		lines.push(`! ${error}`);
	}
	if (shown === 0 && report.errors.length === 0) {
		lines.push(``);
		lines.push(`No servers configured. Add them to .pi/mcp-adapter.json or ~/.pi/agent/mcp-adapter.json.`);
	}
	return lines;
}

/**
 * The `mcp_usage` system prompt section: which MCP servers this session offers and the usage the
 * servers declare themselves. pi only shows these tools as late `toolsAdded` deltas (they are not
 * in the tool list the model plans with), so without this guide the model plans without them.
 * Everything below is rendered verbatim from protocol data: tool descriptions and inputSchemas
 * (`tools/list`) and server instructions (`initialize`), merged from the live tools and the tool
 * cache this extension filled from earlier live lists. Section content is diffed by pi, so a
 * stable guide costs one message.
 */
export function buildMcpUsageGuide(report: AdapterLoadResult, pi?: ExtensionAPI): string[] {
	const lines: string[] = [];
	const legacy = loadToolCache();
	const own = loadOwnToolCache();
	for (const entry of report.entries) {
		const config = entry.config;
		if (!config || config.enabled === false || (config.exposure ?? "codemode") === "hidden") continue;
		const namespaces = namespaceNames(entry.name);
		const proxy = proxyToolName(entry.name);
		const live = (pi?.getAllTools() ?? []).filter(
			(tool) =>
				tool.namespace?.name !== undefined &&
				namespaces.includes(tool.namespace.name) &&
				!tool.name.startsWith("mcp_call__"),
		);
		const liveTools = live.map((tool) => ({
			name: rawToolName(tool),
			description: tool.description,
			inputSchema: tool.parameters,
		}));
		const cached = mergeCachedTools(legacy.get(entry.name), own.get(entry.name), liveTools);
		// Protocol-declared server-level text: namespace description and instructions (initialize).
		const namespaceInfo = live.find((tool) => tool.namespace?.name !== undefined)?.namespace;
		const summary = namespaceInfo?.description ?? config.description ?? "";
		const instructions = namespaceInfo?.instructions?.trim();
		lines.push("");
		lines.push(`- ${entry.name}${summary ? ` — ${summary}` : ""}`);
		if (instructions) lines.push(`  server instructions: ${instructions.replace(/\n+/g, " ")}`);
		if (cached.length === 0) {
			lines.push(`  tools: not listed yet; discover them with ${proxy} and tool="__list__"`);
		} else {
			lines.push(`  tools (the server's own declarations — use exactly these parameters):`);
			for (const tool of cached) {
				lines.push(`    ${mcpToolName(entry.name, tool.name)}${tool.description ? `: ${tool.description}` : ""}`);
				const params = summarizeParameters(tool.inputSchema);
				if (params) lines.push(`      params: ${params}`);
			}
		}
		lines.push(
			`  call proxy: ${proxy} with { "tool": <tool name>, "arguments": <args> } — works while the server connects; prefer the server's own tools once declared.`,
		);
	}
	if (lines.length === 0) return [];
	return [
		`MCP servers are configured for this session. Their tools are first-class: when a task matches one, call it proactively instead of falling back to bash/read workarounds.`,
		`Naming: a server's own tools are mcp__<server>__<tool>; mcp_call__<server> is only its call proxy ({ tool, arguments }) for calls while the server connects and for tool="__list__". The descriptions and params below are the servers' own declarations — follow them exactly and never invent tool names or parameter names.`,
		...lines,
	];
}

export default function mcpAdapterExtension(pi: ExtensionAPI) {
	const state: AdapterState = {
		registered: new Map(),
		report: { entries: [], errors: [], startupWait: false, startupWaitSource: "default", readyTimeout: READY_TIMEOUT_DEFAULT, retries: RETRIES_DEFAULT, retryDelay: RETRY_DELAY_DEFAULT },
		activated: false,
		proxyDefinitions: new Map(),
		proxyKeys: new Map(),
		lastPrompt: "",
		guardSeen: new Set(),
	};

	// Register when the session starts, so the project file is only used in trusted
	// projects and `ctx.cwd` is the session's working directory. The built-in MCP
	// support connects the servers right away.
	pi.on("session_start", (event, ctx) => {
		const loaded = sync(pi, state, ctx);
		const problems = [
			...loaded.entries.filter((entry) => entry.error).map((entry) => `mcp-adapter: ${entry.name}: ${entry.error}`),
			...loaded.errors.map((error) => `mcp-adapter: ${error}`),
		];
		if (problems.length > 0) {
			const message = problems.join("\n");
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else console.error(message);
		} else if (state.registered.size > 0 && event.reason === "startup" && ctx.hasUI) {
			ctx.ui.notify(
				`mcp-adapter: ${state.registered.size} MCP server${state.registered.size === 1 ? "" : "s"} from .pi/mcp-adapter.json`,
				"info",
			);
		}
	});

	// The system prompt's tool list does not show MCP tools (they are declared separately and often
	// only once their server connects), so without a guide the model plans without them and guesses
	// how they work. Inject a `mcp_usage` section and two guidelines before every prompt; pi diffs
	// sections, so a stable guide is recorded once and stays cached.
	pi.on("before_agent_start", (event) => {
		state.lastPrompt = event.messageType === "user" ? event.prompt.trim() : "";
		state.guardSeen.clear();
		const guide = buildMcpUsageGuide(state.report, pi);
		if (guide.length === 0) return;
		const options = event.systemPromptOptions;
		options.sections.mcp_usage = guide.join("\n");
		options.promptGuidelines.push(
			`When a task matches an MCP server's capability (see the mcp_usage section), call its tools proactively — do not assume they are missing or default to bash/read workarounds.`,
			`Follow each MCP tool's declared inputSchema exactly: pass only the parameter names it lists, with the shapes and meanings its descriptions state.`,
			`Build query parameters from the request's entities and intent ("帮我查一下北京明天的天气" → query "北京 天气"); pass the user's question text only where the parameter's description asks for it.`,
		);
	});

	// Query hygiene: a model that plans lazily pastes the user's request into a query parameter and
	// the search runs on the raw sentence. The parameter's own schema description decides what it
	// wants, so bounce the obvious pastes back with the fix instead of letting them through. One
	// identical retry is allowed, so a deliberate pass is not blocked forever.
	pi.on("tool_call", (event) => {
		const toolName = event.toolName;
		if (!toolName.startsWith("mcp__") && !toolName.startsWith("mcp_call__")) return;
		const input: RawEntry = isRecord(event.input) ? event.input : {};
		const nestedTool =
			typeof input.tool === "string" ? input.tool : typeof input.tool_name === "string" ? input.tool_name : undefined;
		const offenses = findRawRequestParams(
			input,
			pi.getAllTools().find((tool) => tool.name === toolName)?.parameters,
			state.lastPrompt,
			nestedTool ? lookupCachedInputSchema(nestedTool) : undefined,
		);
		const offense = offenses[0];
		if (!offense) return;
		const signature = `${toolName}\u0000${offense.path}\u0000${normalizeForCompare(offense.value)}`;
		if (state.guardSeen.has(signature)) return;
		state.guardSeen.add(signature);
		return {
			block: true,
			reason: formatQueryGuardReason(toolName, offense.path, offense.value, offense.paramDesc),
		};
	});

	// With `startupWait: false` (the default), the servers must not join pi's startup connections or
	// the first `before_agent_start`: pi only records the user message after that boundary, and pi 1.1
	// waits for `direct` servers inside it — so registering there delayed the first message's display
	// by seconds and let a second submit race the first one away. Register at the first `turn_start`
	// instead: the boundary stays short, and the call proxies cover calls while the servers connect.
	pi.on("turn_start", (_event, ctx) => {
		if (state.activated) return;
		state.activated = true;
		sync(pi, state, ctx);
	});

	pi.registerCommand("mcp-adapter", {
		description: "Show or reload MCP servers from .pi/mcp-adapter.json",
		getArgumentCompletions: (prefix) => {
			const actions = ["list", "reload"];
			return actions
				.filter((action) => action.startsWith(prefix))
				.map((action) => ({ value: action, label: action }));
		},
		handler: async (args, ctx) => {
			const action = args.trim() || "list";
			if (action !== "list" && action !== "reload") {
				ctx.ui.notify(`Unknown action "${action}" (usage: /mcp-adapter [list|reload])`, "warning");
				return;
			}
			if (action === "reload") {
				state.activated = true;
				sync(pi, state, ctx);
				ctx.ui.notify(
					`mcp-adapter: ${state.registered.size} server${state.registered.size === 1 ? "" : "s"} registered`,
					state.report.entries.some((entry) => entry.error) || state.report.errors.length > 0 ? "warning" : "info",
				);
				return;
			}
			const overridden = mcpJsonNames(ctx.cwd, ctx.isProjectTrusted());
			const registered = new Set(pi.getMcpServers().map((server) => server.name));
			// Tool names are `mcp__<server>__<tool>`; group by the server namespaces (both pi naming schemes).
			const tools = new Map<string, string[]>();
			for (const tool of pi.getAllTools()) {
				const namespace = tool.namespace?.name;
				if (!namespace || tool.name.startsWith("mcp_call__")) continue;
				for (const entry of state.report.entries) {
					if (!namespaceNames(entry.name).includes(namespace)) continue;
					const list = tools.get(entry.name) ?? [];
					list.push(rawToolName(tool));
					tools.set(entry.name, list);
				}
			}
			const lines = describe(state.report, ctx.cwd, overridden, registered, tools, state.proxyDefinitions);
			if (ctx.hasUI) {
				await ctx.ui.select("mcp-adapter", lines);
			} else {
				console.log(lines.join("\n"));
			}
		},
	});
}
