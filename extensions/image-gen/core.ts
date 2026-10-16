/**
 * pi-image-gen core
 *
 * Pure logic for generating images with multimodal models configured in pi's
 * models.json. No pi imports here so this module can also run under plain
 * Node (type stripping) for tests — see selftest.ts.
 *
 * ── The convention ──────────────────────────────────────────────────────
 * pi's models.json schema ignores unknown fields and keeps them verbatim,
 * so this plugin claims the field name `imageGeneration` (unused by pi) to
 * mark a model as image-capable:
 *
 *   { "id": "some-image-model", "imageGeneration": true }
 *   { "id": "some-image-model", "imageGeneration": { "promptTemplate": "..." } }
 *   { "id": "other-model", "imageGeneration": false }   // opt out
 *
 * The field may sit on a model entry, on a provider (default for all of its
 * models), or in `modelOverrides` (highest precedence). A model-level or
 * override-level `false` opts the model out even when the provider opts in.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request as nodeHttpRequest } from "node:http";
import { request as nodeHttpsRequest } from "node:https";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

/* ------------------------------------------------------------------ */
/* HTTP transport                                                      */
/* Pi installs a proxy-aware global fetch which may route even         */
/* loopback/private hosts through HTTP_PROXY (ignoring NO_PROXY).      */
/* Use a direct socket for proxy-exempt targets and fall back to one   */
/* when the global fetch fails, so local gateways keep working.        */
/* ------------------------------------------------------------------ */

export interface RawResponse {
	status: number;
	headers: Record<string, string | undefined>;
	buffer: Buffer;
}

export function shouldBypassProxy(urlStr: string, env: NodeJS.ProcessEnv = process.env): boolean {
	let host: string;
	try {
		host = new URL(urlStr).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (host === "localhost" || host === "::1" || host.endsWith(".localhost")) return true;
	if (/^127\./.test(host)) return true;
	if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
	const noProxy = env.no_proxy ?? env.NO_PROXY ?? "";
	for (const entry of noProxy
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean)) {
		if (entry === "*") return true;
		const suffix = entry.replace(/^\*?\./, "").replace(/:\d+$/, "");
		if (host === suffix || host.endsWith(`.${suffix}`)) return true;
	}
	return false;
}

interface RequestOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string | Buffer;
	signal?: AbortSignal;
}

function directRequestOnce(urlStr: string, opts: RequestOptions): Promise<RawResponse> {
	return new Promise((resolvePromise, reject) => {
		const url = new URL(urlStr);
		const lib = url.protocol === "https:" ? nodeHttpsRequest : nodeHttpRequest;
		const req = lib(url, { method: opts.method ?? "GET", headers: opts.headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk) => chunks.push(chunk));
			// Truncated/aborted responses never emit "end"; settle here so the promise cannot hang.
			res.on("error", reject);
			res.on("aborted", () => reject(new Error("response aborted")));
			res.on("close", () => {
				if (!res.complete) reject(new Error("response closed before complete"));
			});
			res.on("end", () =>
				resolvePromise({
					status: res.statusCode ?? 0,
					headers: res.headers as Record<string, string | undefined>,
					buffer: Buffer.concat(chunks),
				}),
			);
		});
		req.on("error", reject);
		const signal = opts.signal;
		if (signal) {
			if (signal.aborted) {
				req.destroy(new Error("aborted"));
				return;
			}
			const onAbort = () => req.destroy(new Error("aborted"));
			signal.addEventListener("abort", onAbort, { once: true });
			req.on("close", () => signal.removeEventListener("abort", onAbort));
		}
		if (opts.body) req.write(opts.body);
		req.end();
	});
}

/** Direct socket request following up to 5 redirects (307/308 keep method+body). */
async function directRequest(urlStr: string, opts: RequestOptions): Promise<RawResponse> {
	let url = urlStr;
	let method = opts.method ?? "GET";
	let body = opts.body;
	for (let i = 0; i <= 5; i++) {
		const res = await directRequestOnce(url, { ...opts, method, body });
		const location = res.headers.location;
		if (!location || ![301, 302, 303, 307, 308].includes(res.status) || !location) return res;
		url = new URL(location, url).toString();
		if (res.status !== 307 && res.status !== 308) {
			method = "GET";
			body = undefined;
		}
	}
	throw new Error(`too many redirects for ${urlStr}`);
}

async function fetchDirect(urlStr: string, opts: RequestOptions): Promise<RawResponse> {
	const res = await fetch(urlStr, {
		method: opts.method ?? "GET",
		headers: opts.headers,
		body: opts.body,
		signal: opts.signal,
	});
	return {
		status: res.status,
		headers: Object.fromEntries(res.headers.entries()),
		buffer: Buffer.from(await res.arrayBuffer()),
	};
}

/** Direct socket for proxy-exempt hosts; global fetch elsewhere, with a direct
 *  fallback when the (possibly proxy-wrapped) fetch fails on a network error. */
export async function httpRequest(
	urlStr: string,
	opts: RequestOptions,
	env: NodeJS.ProcessEnv = process.env,
): Promise<RawResponse> {
	if (shouldBypassProxy(urlStr, env)) return directRequest(urlStr, opts);
	try {
		return await fetchDirect(urlStr, opts);
	} catch (error) {
		if (opts.signal?.aborted) throw error;
		try {
			return await directRequest(urlStr, opts);
		} catch {
			throw error; // report the original (fetch) failure
		}
	}
}

/* ------------------------------------------------------------------ */
/* The `imageGeneration` field                                        */
/* ------------------------------------------------------------------ */

export type GenerationApi = "chat" | "images" | "anthropic" | "openai-completions" | "openai-images" | "anthropic-messages";

export interface ImageGenerationConfig {
	/** Set false to temporarily disable this model without removing the field. */
	enabled?: boolean;
	/** Mark this model as the default image model. */
	default?: boolean;
	/**
	 * Request style:
	 * - "chat" / "openai-completions" (default): OpenAI-compatible /chat/completions
	 * - "images" / "openai-images": /images/generations
	 * - "anthropic" / "anthropic-messages": Anthropic /messages
	 * When omitted, derived from the pi provider `api` (anthropic-messages → anthropic).
	 */
	api?: GenerationApi;
	/** Override the request path (relative to baseUrl) or a full URL. */
	endpoint?: string;
	/** Optional system prompt for the generation request. */
	systemPrompt?: string;
	/** Optional prompt template. `{{prompt}}` is replaced with the user prompt. */
	promptTemplate?: string;
	/** Maximum images accepted per request (default 4). */
	maxImages?: number;
	/** Request timeout in milliseconds (default 300000). */
	timeoutMs?: number;
	/** Default output directory, relative to the working directory (default "generated-images"). */
	outputDir?: string;
	/** How many generated images to echo back into the tool result for the model to inspect (default 1). */
	previewImages?: number;
	/** API key style: "bearer" (default), "x-api-key", or "none". Defaults to x-api-key for anthropic. */
	authStyle?: "bearer" | "x-api-key" | "none";
	/**
	 * Extra fields merged into the request body (e.g. modalities, image_config).
	 * A key with a `null` value is removed from the body entirely — use that to
	 * drop defaults such as `modalities`, `n`, or `response_format`.
	 */
	request?: Record<string, unknown>;
}

export interface ImageModelEntry {
	/** "provider/model-id" */
	key: string;
	provider: string;
	modelId: string;
	baseUrl: string;
	/** pi provider api (openai-completions, anthropic-messages, ...) */
	api: string;
	apiKeyRaw?: string;
	headers: Record<string, string>;
	samplingParams?: Record<string, unknown>;
	gen: ImageGenerationConfig;
}

const GEN_DEFAULTS = {
	maxImages: 4,
	timeoutMs: 300_000,
	outputDir: "generated-images",
	previewImages: 1,
};

function generationApi(entry: ImageModelEntry): GenerationApi {
	const configured = entry.gen.api;
	if (configured) return configured;
	return entry.api === "anthropic-messages" ? "anthropic" : "chat";
}

/** Normalize `true` / object into a config object; `false` / missing into null. */
export function normalizeGen(value: unknown): ImageGenerationConfig | null {
	if (value === true) return {};
	if (!value || typeof value !== "object") return null;
	const cfg = value as ImageGenerationConfig;
	if (cfg.enabled === false) return null;
	return { ...cfg, request: cfg.request ? { ...cfg.request } : undefined };
}

function mergeGen(
	a: ImageGenerationConfig | null,
	b: ImageGenerationConfig | null,
): ImageGenerationConfig | null {
	if (!a) return b;
	if (!b) return a;
	return { ...a, ...b, request: { ...(a.request ?? {}), ...(b.request ?? {}) } };
}

/* ------------------------------------------------------------------ */
/* models.json discovery (same file pi reads, plus project overlays)   */
/* ------------------------------------------------------------------ */

export function modelsJsonPaths(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return [join(agentDir, "models.json"), join(cwd, ".pi", "models.json"), join(cwd, "models.json")];
}

/** Strip // and /* *\/ comments and a BOM, ignoring comment markers inside strings. */
export function stripJsonComments(text: string): string {
	let out = "";
	let inString = false;
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const n = text[i + 1];
		if (inLine) {
			if (c === "\n") {
				inLine = false;
				out += c;
			}
			continue;
		}
		if (inBlock) {
			if (c === "*" && n === "/") {
				inBlock = false;
				i++;
			} else if (c === "\n") {
				out += "\n";
			}
			continue;
		}
		if (inString) {
			out += c;
			if (c === "\\") {
				if (n !== undefined) out += n;
				i++;
			} else if (c === '"') {
				inString = false;
			}
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			continue;
		}
		if (c === "/" && n === "/") {
			inLine = true;
			i++;
			continue;
		}
		if (c === "/" && n === "*") {
			inBlock = true;
			i++;
			continue;
		}
		out += c;
	}
	return out.replace(/^\uFEFF/, "");
}

export function readJsonc(path: string): Record<string, any> | undefined {
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
	try {
		return JSON.parse(stripJsonComments(content));
	} catch (error) {
		throw new Error(`Failed to parse ${path}: ${error instanceof Error ? error.message : error}`);
	}
}

const PROVIDER_SCALARS = ["name", "baseUrl", "apiKey", "api", "headers", "authHeader", "imageGeneration"] as const;

/**
 * Load image-capable models from pi's models.json (and optional project
 * overlays). Later files override earlier ones per provider/model.
 */
export function loadImageModels(cwd: string, env: NodeJS.ProcessEnv = process.env): ImageModelEntry[] {
	interface Accumulated {
		scalars: Record<string, unknown>;
		models: Map<string, Record<string, any>>;
		modelOverrides: Record<string, Record<string, any>>;
	}
	const providers = new Map<string, Accumulated>();

	for (const path of modelsJsonPaths(cwd, env)) {
		const raw = readJsonc(path);
		if (!raw?.providers || typeof raw.providers !== "object") continue;
		for (const [providerId, provider] of Object.entries(raw.providers as Record<string, any>)) {
			if (!provider || typeof provider !== "object") continue;
			const acc: Accumulated = providers.get(providerId) ?? {
				scalars: {},
				models: new Map(),
				modelOverrides: {},
			};
			for (const key of PROVIDER_SCALARS) {
				if (provider[key] !== undefined) acc.scalars[key] = provider[key];
			}
			if (Array.isArray(provider.models)) {
				for (const model of provider.models) {
					if (!model || typeof model !== "object" || typeof model.id !== "string") continue;
					acc.models.set(model.id, { ...acc.models.get(model.id), ...model });
				}
			}
			if (provider.modelOverrides && typeof provider.modelOverrides === "object") {
				for (const [id, override] of Object.entries(provider.modelOverrides)) {
					if (!override || typeof override !== "object") continue;
					acc.modelOverrides[id] = { ...acc.modelOverrides[id], ...(override as Record<string, any>) };
				}
			}
			providers.set(providerId, acc);
		}
	}

	const entries: ImageModelEntry[] = [];
	for (const [providerId, acc] of providers) {
		const scalars = acc.scalars;
		const providerGen = normalizeGen(scalars.imageGeneration);
		for (const [modelId, model] of acc.models) {
			const override = acc.modelOverrides[modelId];
			// An explicit `false` at model or override level opts out, even when
			// the provider opts all of its models in.
			if (model.imageGeneration === false || override?.imageGeneration === false) continue;
			const gen = mergeGen(mergeGen(providerGen, normalizeGen(model.imageGeneration)), normalizeGen(override?.imageGeneration));
			if (!gen) continue;
			const headers: Record<string, string> = {
				...((scalars.headers as Record<string, string> | undefined) ?? {}),
				...((model.headers as Record<string, string> | undefined) ?? {}),
			};
			entries.push({
				key: `${providerId}/${modelId}`,
				provider: providerId,
				modelId,
				baseUrl: String(scalars.baseUrl ?? ""),
				api: String(model.api ?? scalars.api ?? "openai-completions"),
				apiKeyRaw: scalars.apiKey as string | undefined,
				headers,
				samplingParams: model.samplingParams as Record<string, unknown> | undefined,
				gen,
			});
		}
	}
	return entries;
}

/** "$NAME" / "${NAME}" expansion for apiKey fallback when the registry cannot resolve auth. */
export function interpolateEnv(value?: string): string | undefined {
	if (!value) return value;
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, a, b) => {
		const resolved = process.env[a ?? b];
		return resolved !== undefined ? resolved : match;
	});
}

export interface ModelSelection {
	entry?: ImageModelEntry;
	error?: string;
}

/** Pick a model: explicit key > PI_IMAGE_GEN_MODEL > `default: true` > first entry. */
export function selectModel(
	entries: ImageModelEntry[],
	modelKey: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ModelSelection {
	if (entries.length === 0) {
		return {
			error:
				"No image-generation models configured. Mark a model in models.json with the custom " +
				'"imageGeneration" field (e.g. "imageGeneration": true). See pi-image-gen/README.md.',
		};
	}
	const wanted = modelKey?.trim() || env.PI_IMAGE_GEN_MODEL?.trim();
	if (wanted) {
		const lower = wanted.toLowerCase();
		const match =
			entries.find((e) => e.key.toLowerCase() === lower) ??
			entries.find((e) => e.modelId.toLowerCase() === lower);
		if (!match) {
			return {
				error: `Image model "${wanted}" not found. Available: ${entries.map((e) => e.key).join(", ")}`,
			};
		}
		return { entry: match };
	}
	const def = entries.find((e) => e.gen.default === true);
	return { entry: def ?? entries[0] };
}

/* ------------------------------------------------------------------ */
/* Request building                                                   */
/* ------------------------------------------------------------------ */

export interface ReferenceImage {
	dataUri: string;
}

export interface GenerateOptions {
	prompt: string;
	modelKey?: string;
	count?: number;
	size?: string;
	/** File paths (relative to cwd), http(s) URLs, or data: URIs. */
	referenceImages?: string[];
	outputDir?: string;
	fileName?: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	/** Resolve auth for an entry (pi's model registry in the extension, raw key in tests). */
	resolveAuth: (entry: ImageModelEntry) => Promise<ResolvedAuth>;
	onProgress?: (message: string) => void;
}

export interface ResolvedAuth {
	apiKey?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
}

export interface SavedImage {
	path: string;
	mimeType: string;
	bytes: number;
	/** base64 payload, kept for tool-result previews (not for details). */
	data: string;
}

export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface GenerateResult {
	entry: ImageModelEntry;
	saved: SavedImage[];
	errors: string[];
	usage?: UsageLike;
	text: string;
}

export function applyPromptTemplate(template: string | undefined, prompt: string): string {
	if (!template) return prompt;
	return template.includes("{{prompt}}") ? template.replaceAll("{{prompt}}", prompt) : `${template}\n\n${prompt}`;
}

export function joinUrl(baseUrl: string, endpoint: string): string {
	if (/^https?:\/\//.test(endpoint)) return endpoint;
	return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

/** Drop keys whose configured value is `null` (config-level "remove this field"). */
export function stripNulls(body: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(body)) {
		if (value !== null) out[key] = value;
	}
	return out;
}

function parseDataUri(dataUri: string): { mimeType: string; data: string } | undefined {
	const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUri.trim());
	if (!match) return undefined;
	return { mimeType: match[1], data: match[2].replace(/\s+/g, "") };
}

export function buildRequest(
	entry: ImageModelEntry,
	auth: ResolvedAuth,
	opts: { prompt: string; count: number; size?: string; referenceImages?: ReferenceImage[] },
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
	const gen = entry.gen;
	const api = generationApi(entry);
	const prompt = applyPromptTemplate(gen.promptTemplate, opts.prompt);
	const headers: Record<string, string> = {
		"content-type": "application/json",
		...(auth.headers ?? {}),
		...entry.headers,
	};
	const authStyle = gen.authStyle ?? (api === "anthropic" ? "x-api-key" : "bearer");
	const apiKey = auth.apiKey ?? interpolateEnv(entry.apiKeyRaw);
	if (apiKey && authStyle === "bearer") headers.authorization = `Bearer ${apiKey}`;
	else if (apiKey && authStyle === "x-api-key") headers["x-api-key"] = apiKey;

	const baseUrl = auth.baseUrl ?? entry.baseUrl;
	let endpoint = gen.endpoint;
	let body: Record<string, unknown>;

	if (api === "images" || api === "openai-images") {
		endpoint ??= "images/generations";
		// No response_format by default: gpt-image-family endpoints reject it,
		// and both b64_json and url responses are handled when parsing.
		// Add it back via `request` for endpoints that need it.
		body = {
			model: entry.modelId,
			prompt,
			n: opts.count,
			...(opts.size ? { size: opts.size } : {}),
			...(entry.samplingParams ?? {}),
			...(gen.request ?? {}),
		};
	} else if (api === "anthropic" || api === "anthropic-messages") {
		endpoint ??= "messages";
		headers["anthropic-version"] ??= "2023-06-01";
		const userContent: unknown[] = [{ type: "text", text: prompt }];
		for (const ref of opts.referenceImages ?? []) {
			const parsed = parseDataUri(ref.dataUri);
			userContent.push(
				parsed
					? { type: "image", source: { type: "base64", media_type: parsed.mimeType, data: parsed.data } }
					: { type: "image", source: { type: "url", url: ref.dataUri } },
			);
		}
		body = {
			model: entry.modelId,
			max_tokens: 4096,
			...(gen.systemPrompt ? { system: gen.systemPrompt } : {}),
			messages: [{ role: "user", content: userContent }],
			...(entry.samplingParams ?? {}),
			...(gen.request ?? {}),
		};
	} else {
		endpoint ??= "chat/completions";
		const messages: unknown[] = [];
		if (gen.systemPrompt) messages.push({ role: "system", content: gen.systemPrompt });
		const userContent: unknown[] = [{ type: "text", text: prompt }];
		for (const ref of opts.referenceImages ?? []) {
			userContent.push({ type: "image_url", image_url: { url: ref.dataUri } });
		}
		messages.push({ role: "user", content: userContent });
		body = {
			model: entry.modelId,
			messages,
			modalities: ["text", "image"],
			...(entry.samplingParams ?? {}),
			...(gen.request ?? {}),
		};
		if (opts.count > 1 && body.n === undefined) body.n = opts.count;
		if (opts.size && body.image_config === undefined) body.image_config = { size: opts.size };
	}

	return { url: joinUrl(baseUrl, endpoint), headers, body: stripNulls(body) };
}

/* ------------------------------------------------------------------ */
/* Image extraction                                                   */
/* ------------------------------------------------------------------ */

export type RawImage = { kind: "b64"; data: string; mimeType?: string } | { kind: "url"; url: string };

// Base64 runs may contain \r\n line wraps; spaces terminate (they mark prose).
const DATA_URI_RE = /data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)/g;
const MD_IMG_RE = /!\[[^\]]*\]\(<?([^)\s]+)>?[^)]*\)/g;
const HTML_IMG_RE = /<img[^>]+src=["']([^"']+)["']/gi;
const BARE_URL_RE = /https?:\/\/[^\s"'<>()\]]+/g;

export function sniffImageMime(base64: string): string | undefined {
	const head = Buffer.from(base64.replace(/\s+/g, "").slice(0, 32), "base64");
	if (head.length >= 8 && head[0] === 0x89 && head.toString("latin1", 1, 4) === "PNG") return "image/png";
	if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
	if (head.toString("latin1", 0, 4) === "GIF8") return "image/gif";
	if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "image/webp";
	return undefined;
}

/** Collect images from every response shape we know: OpenAI chat content
 *  parts, images-API `data[]`, Gemini `candidates[].content.parts[]`, and
 *  images embedded as markdown / data URIs in text. */
export function extractImages(json: any): RawImage[] {
	const out: RawImage[] = [];
	const seen = new Set<string>();

	const pushB64 = (data: unknown, mimeType?: string) => {
		if (typeof data !== "string") return;
		const clean = data.replace(/\s+/g, "");
		if (clean.length < 16) return;
		// Hash the full payload: image headers are near-identical for same-size
		// images, so a prefix key would wrongly dedupe distinct images.
		const key = `b:${createHash("sha256").update(clean).digest("hex")}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ kind: "b64", data: clean, mimeType: mimeType || sniffImageMime(clean) });
	};
	const pushUrl = (url: unknown) => {
		if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
		if (seen.has(`u:${url}`)) return;
		seen.add(`u:${url}`);
		out.push({ kind: "url", url });
	};
	const handleUrlish = (value: string) => {
		const trimmed = value.trim().replace(/^<|>$/g, "");
		if (/^data:/i.test(trimmed)) {
			const parsed = parseDataUri(trimmed);
			if (parsed) pushB64(parsed.data, parsed.mimeType);
			return;
		}
		pushUrl(trimmed);
	};
	const scanText = (text: string) => {
		if (!text) return;
		for (const m of text.matchAll(DATA_URI_RE)) pushB64(m[2], m[1]);
		for (const m of text.matchAll(MD_IMG_RE)) handleUrlish(m[1]);
		for (const m of text.matchAll(HTML_IMG_RE)) handleUrlish(m[1]);
		for (const m of text.matchAll(BARE_URL_RE)) {
			if (/\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(m[0])) pushUrl(m[0]);
		}
	};
	const collectPart = (part: any) => {
		if (!part || typeof part !== "object") {
			if (typeof part === "string") scanText(part);
			return;
		}
		const type = part.type;
		if (type === "text" && typeof part.text === "string") {
			scanText(part.text);
			return;
		}
		const inline = part.inlineData ?? part.inline_data;
		if (inline && typeof inline === "object") {
			pushB64(inline.data, inline.mimeType ?? inline.mime_type);
			return;
		}
		const source = part.source;
		if (source && typeof source === "object") {
			if (typeof source.data === "string") {
				pushB64(source.data, source.media_type ?? source.mediaType);
				return;
			}
			if (typeof source.url === "string") {
				pushUrl(source.url);
				return;
			}
		}
		const imageUrl = part.image_url ?? part.imageUrl;
		const url = typeof imageUrl === "string" ? imageUrl : imageUrl?.url;
		if (typeof url === "string" && url) {
			handleUrlish(url);
			return;
		}
		if (typeof part.b64_json === "string") {
			pushB64(part.b64_json, part.mime_type ?? part.mimeType);
			return;
		}
		if (typeof part.data === "string") {
			pushB64(part.data, part.mime_type ?? part.mimeType);
			return;
		}
		if (typeof part.url === "string") {
			handleUrlish(part.url);
			return;
		}
		const fileData = part.fileData ?? part.file_data;
		const fileUri = fileData?.fileUri ?? fileData?.file_uri;
		if (typeof fileUri === "string") pushUrl(fileUri);
	};
	const collectContent = (content: unknown) => {
		if (typeof content === "string") scanText(content);
		else if (Array.isArray(content)) for (const part of content) collectPart(part);
	};

	if (!json || typeof json !== "object") return out;

	// OpenAI chat completions
	if (Array.isArray(json.choices)) {
		for (const choice of json.choices) {
			collectContent(choice?.message?.content);
			for (const key of ["images", "attachments", "parts"]) {
				if (Array.isArray(choice?.message?.[key])) {
					for (const part of choice.message[key]) collectPart(part);
				}
			}
		}
	}
	// Some gateways return { message: {...} } without choices
	if (json.message && !json.choices) collectContent(json.message.content);
	// Anthropic-style or plain content arrays at the top level
	if (Array.isArray(json.content)) for (const part of json.content) collectPart(part);

	// images-API style: { data: [{ b64_json | url }] }
	if (Array.isArray(json.data)) for (const item of json.data) collectPart(item);
	// { images: [...] }
	if (Array.isArray(json.images)) for (const item of json.images) collectPart(item);
	// OpenAI Responses image generation: { output: [{ type: "image_generation_call", result }] }
	if (Array.isArray(json.output)) {
		for (const item of json.output) {
			if (typeof item?.result === "string") pushB64(item.result);
			if (Array.isArray(item?.content)) for (const part of item.content) collectPart(part);
		}
	} else if (Array.isArray(json.output?.images)) {
		for (const item of json.output.images) collectPart(item);
	}
	// Gemini native: { candidates: [{ content: { parts: [{ inlineData }] } }] }
	if (Array.isArray(json.candidates)) {
		for (const candidate of json.candidates) {
			for (const part of candidate?.content?.parts ?? []) collectPart(part);
		}
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* Saving                                                             */
/* ------------------------------------------------------------------ */

const EXT_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/avif": "avif",
};

export function extForMime(mimeType: string | undefined): string {
	return EXT_BY_MIME[mimeType ?? ""] ?? "png";
}

export function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.trim();
	return slug || "image";
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export async function resolveReferenceImage(ref: string, cwd: string): Promise<ReferenceImage> {
	if (/^data:/i.test(ref)) return { dataUri: ref };
	if (/^https?:\/\//i.test(ref)) return { dataUri: ref }; // providers fetch URLs themselves
	const path = isAbsolute(ref) ? ref : resolve(cwd, ref);
	const data = await readFile(path);
	const mimeType =
		{ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }[
			extname(path).toLowerCase()
		] ?? "image/png";
	return { dataUri: `data:${mimeType};base64,${data.toString("base64")}` };
}

async function downloadImage(url: string, signal?: AbortSignal): Promise<{ data: string; mimeType: string }> {
	const res = await httpRequest(url, { signal });
	if (res.status < 200 || res.status >= 300) throw new Error(`failed to download ${url}: HTTP ${res.status}`);
	const contentType = res.headers["content-type"]?.split(";")[0].trim();
	const mimeType = contentType?.startsWith("image/")
		? contentType
		: sniffImageMime(res.buffer.toString("base64")) ?? "image/png";
	return { data: res.buffer.toString("base64"), mimeType };
}

async function uniquePath(dir: string, name: string): Promise<string> {
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	for (let i = 0; i < 100; i++) {
		const candidate = join(dir, i === 0 ? name : `${stem}-${i + 1}${ext}`);
		try {
			readFileSync(candidate);
		} catch {
			return candidate;
		}
	}
	return join(dir, `${stem}-${Date.now()}${ext}`);
}

export async function saveImages(
	rawImages: RawImage[],
	opts: { cwd: string; outputDir: string; fileName?: string; prompt: string; signal?: AbortSignal },
): Promise<{ saved: SavedImage[]; errors: string[] }> {
	const saved: SavedImage[] = [];
	const errors: string[] = [];
	const dir = isAbsolute(opts.outputDir) ? opts.outputDir : resolve(opts.cwd, opts.outputDir);
	await mkdir(dir, { recursive: true });

	for (let i = 0; i < rawImages.length; i++) {
		const raw = rawImages[i];
		try {
			let data: string;
			let mimeType: string;
			if (raw.kind === "url") {
				const downloaded = await downloadImage(raw.url, opts.signal);
				data = downloaded.data;
				mimeType = downloaded.mimeType;
			} else {
				data = raw.data;
				mimeType = raw.mimeType ?? sniffImageMime(raw.data) ?? "image/png";
			}
			const buffer = Buffer.from(data, "base64");
			const ext = extForMime(mimeType);
			let name: string;
			if (opts.fileName) {
				// basename() blocks path traversal out of the output directory.
				const base = basename(opts.fileName).replace(/\.[a-z0-9]+$/i, "") || "image";
				const suffix = rawImages.length > 1 ? `-${i + 1}` : "";
				name = `${base}${suffix}.${ext}`;
			} else {
				name = `${slugify(opts.prompt)}-${timestamp()}-${i + 1}.${ext}`;
			}
			const path = await uniquePath(dir, name);
			await writeFile(path, buffer);
			saved.push({ path, mimeType, bytes: buffer.length, data });
		} catch (error) {
			errors.push(`image ${i + 1}: ${error instanceof Error ? error.message : error}`);
		}
	}
	return { saved, errors };
}

/* ------------------------------------------------------------------ */
/* Usage                                                              */
/* ------------------------------------------------------------------ */

export function mapUsage(raw: any): UsageLike | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const input = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0);
	const output = Number(raw.completion_tokens ?? raw.output_tokens ?? 0);
	const total = Number(raw.total_tokens ?? input + output);
	return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: total };
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/* High-level generation                                              */
/* ------------------------------------------------------------------ */

export async function generateImages(options: GenerateOptions): Promise<GenerateResult> {
	const env = options.env ?? process.env;
	const entries = loadImageModels(options.cwd, env);
	const selection = selectModel(entries, options.modelKey, env);
	if (!selection.entry) throw new Error(selection.error ?? "No image model available");
	const entry = selection.entry;
	const gen = entry.gen;
	const api = generationApi(entry);

	const maxImages = Math.max(1, gen.maxImages ?? GEN_DEFAULTS.maxImages);
	const requested = Number.isFinite(options.count) ? Math.trunc(options.count!) : 1;
	const count = Math.max(1, Math.min(requested, maxImages));
	const onProgress = options.onProgress ?? (() => {});
	const warnings: string[] = [];

	onProgress(`Using ${entry.key} to generate ${count} image(s)...`);

	const referenceImages: ReferenceImage[] = [];
	for (const ref of options.referenceImages ?? []) {
		referenceImages.push(await resolveReferenceImage(ref, options.cwd));
	}
	if (referenceImages.length > 0 && (api === "images" || api === "openai-images")) {
		warnings.push("referenceImages are not supported by the images API and were ignored");
	}

	const auth = await options.resolveAuth(entry);
	const request = buildRequest(entry, auth, {
		prompt: options.prompt,
		count,
		size: options.size,
		referenceImages: api === "images" || api === "openai-images" ? [] : referenceImages,
	});

	const timeoutMs = gen.timeoutMs ?? GEN_DEFAULTS.timeoutMs;
	const signals = [AbortSignal.timeout(timeoutMs), options.signal].filter(Boolean) as AbortSignal[];
	const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

	onProgress(`POST ${request.url}`);
	const response = await httpRequest(
		request.url,
		{
			method: "POST",
			headers: request.headers,
			body: JSON.stringify(request.body),
			signal,
		},
		env,
	);
	const responseText = response.buffer.toString("utf-8");
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Image model request failed (HTTP ${response.status}): ${responseText.slice(0, 2000)}`);
	}

	let json: any;
	try {
		json = JSON.parse(responseText);
	} catch {
		throw new Error(`Image model returned non-JSON response: ${responseText.slice(0, 500)}`);
	}

	const rawImages = extractImages(json);
	if (rawImages.length === 0) {
		throw new Error(
			`No images found in the model response. Response preview: ${responseText.slice(0, 500)}`,
		);
	}

	onProgress(`Received ${rawImages.length} image(s), saving...`);
	const { saved, errors } = await saveImages(rawImages, {
		cwd: options.cwd,
		outputDir: options.outputDir ?? gen.outputDir ?? GEN_DEFAULTS.outputDir,
		fileName: options.fileName,
		prompt: options.prompt,
		signal, // merged timeout+caller signal, so timeoutMs also covers the download phase
	});
	if (saved.length === 0) {
		throw new Error(`Images were returned but could not be saved: ${errors.join("; ")}`);
	}
	warnings.push(...errors);

	const lines = [
		`Generated ${saved.length} image(s) with ${entry.key}:`,
		...saved.map((img) => `- ${img.path} (${formatBytes(img.bytes)}, ${img.mimeType})`),
	];
	if (warnings.length > 0) lines.push(`Warnings: ${warnings.join("; ")}`);

	return {
		entry,
		saved,
		errors: warnings,
		usage: mapUsage(json.usage),
		text: lines.join("\n"),
	};
}
