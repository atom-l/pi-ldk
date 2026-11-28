/**
 * pi-image-gen — generate images with multimodal models configured in models.json
 *
 * Prefer Pi's native image registry; keep imageGeneration transports for legacy models.
 *
 * Provides:
 *   - tool    `generate_image`  — model-callable image generation / editing
 *   - command `/imagine`        — user-facing generation and model listing
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type GenerateOptions,
	type ImageModelEntry,
	type ResolvedAuth,
	type SavedImage,
	formatBytes,
	selectModel,
} from "./core.ts";

import { catalog, generate, preferredBackend, type Choice } from './backend.ts';
import { imagineTokens } from './paths.ts';

type ResultContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/* ------------------------------------------------------------------ */
/* Auth: pi's model registry first (handles auth.json, env, OAuth,     */
/* `!command` keys), raw models.json apiKey as fallback.               */
/* ------------------------------------------------------------------ */

async function resolveAuth(ctx: ExtensionContext, entry: ImageModelEntry): Promise<ResolvedAuth> {
	let auth: ResolvedAuth = { apiKey: entry.apiKeyRaw, baseUrl: entry.baseUrl, headers: entry.headers };
	try {
		const model = ctx.modelRegistry.find(entry.provider, entry.modelId);
		if (model) {
			const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (resolved.ok) {
				auth = {
					apiKey: resolved.apiKey ?? auth.apiKey,
					baseUrl: resolved.baseUrl ?? auth.baseUrl,
					// ProviderHeaders is Record<string, string | null>; `null` means "suppress the
					// default header", so drop those entries instead of sending the literal "null".
					headers: Object.fromEntries(
						Object.entries({ ...(resolved.headers ?? {}), ...(auth.headers ?? {}) }).filter(
							(entry): entry is [string, string] => typeof entry[1] === "string",
						),
					),
				};
			}
		}
	} catch {
		// registry unavailable — fall back to the raw models.json values
	}
	return auth;
}


/* ------------------------------------------------------------------ */
/* Tool                                                               */
/* ------------------------------------------------------------------ */

const GenerateParams = Type.Object({
	prompt: Type.String({
		description: "Text description of the image to generate. When referenceImages are given, describe the desired edit instead.",
	}),
	model: Type.Optional(
		Type.String({
			description:
				'Image model key as "provider/model-id" (or just "model-id"). Omit to use the default image model.',
		}),
	),
	count: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: "Number of images to generate (default 1)." })),
	size: Type.Optional(
		Type.String({ description: 'Optional resolution. For a native Pi 1.7 OpenRouter or Radius image model use a provider-supported tier such as "2K". Pixel dimensions such as "1024x1024" require a legacy imageGeneration backend.' }),
	),
	referenceImages: Type.Optional(
		Type.Array(Type.String(), {
			description: "Reference images for image-to-image editing: paths relative to the working directory, URLs, or data: URIs.",
		}),
	),
	outputDir: Type.Optional(
		Type.String({
			description:
				"Directory for the generated files (default: generated-images under the working directory). " +
				'Relative paths must stay under the working directory (no ".."); use an absolute path to write elsewhere.',
		}),
	),
	fileName: Type.Optional(
		Type.String({ description: "Base file name without extension (default derived from the prompt and timestamp)." }),
	),
});

interface GenerateDetails {
	model: string;
	prompt: string;
	files: { path: string; mimeType: string; bytes: number }[];
	errors: string[];
}

function toResultContent(text: string, saved: SavedImage[], previewImages: number): ResultContent[] {
	const content: ResultContent[] = [{ type: "text", text }];
	for (const img of saved.slice(0, Math.max(0, previewImages))) {
		// Keep tool results reasonably small; larger files stay on disk for `read`.
		if (img.data.length > 3_000_000) continue;
		content.push({ type: "image", data: img.data, mimeType: img.mimeType });
	}
	return content;
}

/* ------------------------------------------------------------------ */
/* Extension entry point                                              */
/* ------------------------------------------------------------------ */

export default function imageGenExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "generate_image",
		label: "generate image",
		description:
			"Generate or edit images with a Pi image model or a legacy imageGeneration model. Writes files and returns their paths. " +
			'Use the "model" parameter ("provider/model-id") to pick one; omit it for the default model. ' +
			"The first generated image is usually echoed back so you can inspect the result; use the read tool on the saved files for more.",
		promptSnippet: "Generate or edit images with a configured image model; writes files and returns their paths.",
		promptGuidelines: [
			"For image creation or editing tasks, use generate_image and treat the returned file paths as the deliverable.",
			"Set referenceImages to existing image files when the task is editing or style transfer instead of plain generation.",
		],
		parameters: GenerateParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const options: GenerateOptions = {
				prompt: params.prompt,
				modelKey: params.model,
				count: params.count,
				size: params.size,
				referenceImages: params.referenceImages,
				outputDir: params.outputDir,
				fileName: params.fileName,
				cwd: ctx.cwd,
				signal,
				resolveAuth: (entry) => resolveAuth(ctx, entry),
				onProgress: (message) => {
					onUpdate?.({
						content: [{ type: "text", text: message }],
						details: { model: params.model ?? "(default)", prompt: params.prompt, files: [], errors: [] },
					});
				},
			};

			const result = await generate(ctx, options);
			const previewImages = result.entry.gen.previewImages ?? 1;
			const details: GenerateDetails = {
				model: result.entry.key,
				prompt: params.prompt,
				files: result.saved.map((img) => ({ path: img.path, mimeType: img.mimeType, bytes: img.bytes })),
				errors: result.errors,
			};

			const resultText =
				result.text +
				(previewImages > 0 ? `\nPreviewing ${Math.min(previewImages, result.saved.length)} image(s) in this result.` : "") +
				`\nUse the read tool on the file paths above to inspect the images.`;

			return {
				content: toResultContent(resultText, result.saved, previewImages),
				details,
				usage: result.usage
					? {
							// Keep the registry's optional token breakdowns (e.g. imageOutput).
							...result.usage,
							cost: result.usage.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						}
					: undefined,
			};
		},
	});

	/* -------------------------------------------------------------- */
	/* Command: /imagine                                              */
	/* -------------------------------------------------------------- */

	const notify = (ctx: ExtensionContext, message: string, type?: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(message, type);
		else console.log(`[image-gen] ${message}`);
	};

	/** Live progress panel: spinner + elapsed time + stage, refreshed twice a
	 *  second so a multi-minute image request never looks like a hang. */
	const startProgress = (ctx: ExtensionContext, title: string) => {
		const enabled = ctx.hasUI;
		const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		const started = Date.now();
		let stage = "准备中...";
		let frame = 0;
		let timer: ReturnType<typeof setInterval> | undefined;
		const elapsed = () => {
			const s = Math.floor((Date.now() - started) / 1000);
			return s >= 60 ? `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s` : `${s}s`;
		};
		const render = () => {
			if (!enabled) return;
			// The UI can be torn down mid-generation. A throw here would either
			// escape the setInterval callback (process-level crash) or surface
			// through onProgress as a bogus "generation failed" error.
			try {
				const spinner = frames[frame++ % frames.length];
				ctx.ui.setStatus("image-gen", `${title} ${elapsed()}`);
				ctx.ui.setWidget("image-gen-progress", [`${spinner} ${title} — ${elapsed()}`, `   ${stage}`]);
			} catch {
				// ignore UI errors during teardown
			}
		};
		if (enabled) {
			timer = setInterval(render, 500);
			timer.unref?.();
			render();
		}
		return {
			setStage(message: string) {
				// Translate core progress messages into UI stages.
				const using = /^Using (.+) to generate/.exec(message);
				const received = /^Received (\d+) image/.exec(message);
				if (using) stage = `使用 ${using[1]} 生成中…`;
				else if (message.startsWith("POST ")) stage = "请求已发送,等待模型出图…(通常 30~120 秒)";
				else if (received) stage = `已收到 ${received[1]} 张图片,保存中…`;
				else stage = message;
				render();
			},
			elapsed,
			stop() {
				if (timer) clearInterval(timer);
				if (enabled) {
					try {
						ctx.ui.setWidget("image-gen-progress", undefined);
						ctx.ui.setStatus("image-gen", undefined);
					} catch {
						// ignore UI errors during teardown
					}
				}
			},
		};
	};

	const SIZE_CHOICES = [
		"默认（模型自定）",
		"1024x1024 (1:1)",
		"1536x1024 (3:2)",
		"1024x1536 (2:3)",
		"1792x1024 (16:9)",
		"1024x1792 (9:16)",
		"自定义...",
	];

	pi.registerCommand("imagine", {
		description:
			"Generate images interactively: /imagine [prompt] — pickers ask for model, size, and count. " +
			"Flags skip the matching picker (model=provider/id size=2K out=dir; legacy example: size=1024x1024 n=2). /imagine list shows configured models.",
		handler: async (args, ctx) => {
			let tokens: string[];
			try { tokens = imagineTokens(args); } catch (error) { notify(ctx, String(error), 'error'); return; }
			if (tokens[0] === "list" || tokens[0] === "models") {
				// Must never throw out of the handler: a malformed models.json
				// degrades to an error notice, like the extension entry point.
				let list: Choice[];
				try {
					list = await catalog(ctx);
				} catch (error) {
					const message = `models.json could not be read: ${error instanceof Error ? error.message : error}`;
					if (ctx.hasUI) ctx.ui.notify(message, "error");
					else console.log(message);
					return;
				}
				const lines = list.map((e) => {
					const cfg = e.gen;
					const parts = [
						preferredBackend(e),
						cfg.default ? "default" : null,
						cfg.api && cfg.api !== "chat" ? `api=${cfg.api}` : null,
						cfg.promptTemplate ? `promptTemplate=${JSON.stringify(cfg.promptTemplate)}` : null,
						cfg.outputDir ? `outputDir=${cfg.outputDir}` : null,
					].filter(Boolean);
					return `${e.key}${parts.length ? `  (${parts.join(", ")})` : ""}`;
				});
				const message = lines.length
					? `Image models:\n${lines.join("\n")}`
					: 'No available Pi image model or legacy imageGeneration entry.';
				if (ctx.hasUI) ctx.ui.notify(message, lines.length ? "info" : "warning");
				else console.log(message);
				return;
			}

			let modelKey: string | undefined;
			let count: number | undefined;
			let size: string | undefined;
			let outputDir: string | undefined;
			const promptParts: string[] = [];
			for (const token of tokens) {
				const kv = /^(model|n|count|size|out|outputDir)=(.+)$/i.exec(token);
				if (kv) {
					const key = kv[1].toLowerCase();
					const value = kv[2];
					if (key === "model") modelKey = value;
					else if (key === "n" || key === "count") count = Number(value);
					else if (key === "size") size = value;
					else outputDir = value;
				} else {
					promptParts.push(token);
				}
			}

			let prompt = promptParts.join(" ").trim();
			let entries: Choice[] | undefined;

			if (ctx.hasUI) {
				// Interactive flow: prompt → model → size → count. A provided flag
				// skips its picker; Esc in any picker cancels the whole run.
				if (!prompt) {
					prompt = ((await ctx.ui.input("图片提示词", "一只雪地里的水彩风格小狐狸")) ?? "").trim();
					if (!prompt) {
						notify(ctx, "已取消", "info");
						return;
					}
				}

				try {
					entries = await catalog(ctx);
				} catch (error) {
					notify(ctx, `models.json could not be read: ${error instanceof Error ? error.message : error}`, "error");
					return;
				}
				if (entries.length === 0) {
					notify(ctx, '没有可用的 Pi 图片模型或旧 imageGeneration 模型。请检查提供商凭据或模型配置。', "warning");
					return;
				}

				if (!modelKey) {
					if (entries.length === 1) {
						modelKey = entries[0].key;
					} else {
						const options = entries.map((e) => `${e.key}${e.gen.default ? " (默认)" : ""}`);
						const picked = await ctx.ui.select("选择生图模型", options);
						if (!picked) {
							notify(ctx, "已取消", "info");
							return;
						}
						const index = options.indexOf(picked);
						modelKey =
							(index >= 0 ? entries[index]?.key : entries.find((e) => picked.startsWith(e.key))?.key) ?? entries[0].key;
					}
				}

				const selection = selectModel(entries, modelKey);
				const selected = selection.entry as Choice | undefined;
				if (!selected) { notify(ctx, selection.error ?? `找不到图片模型：${modelKey}`, 'error'); return; }
				if (!size && selected.legacy) {
					const picked = await ctx.ui.select("选择尺寸", SIZE_CHOICES);
					if (!picked) {
						notify(ctx, "已取消", "info");
						return;
					}
					if (picked.startsWith("自定义")) {
						size = (await ctx.ui.input("自定义尺寸（如 1280x720）", "1280x720"))?.trim();
						if (!size) { notify(ctx, '已取消', 'info'); return; }
					} else if (!picked.startsWith("默认")) {
						size = picked.split(" ")[0];
					}
				}

				if (count === undefined) {
					const entry = selectModel(entries, modelKey, process.env).entry;
					const maxImages = Math.max(1, entry?.gen.maxImages ?? 4);
					if (maxImages > 1) {
						const options = [1, 2, 3, 4].filter((n) => n <= maxImages).map(String);
						const picked = await ctx.ui.select("生成张数", options);
						if (!picked) {
							notify(ctx, "已取消", "info");
							return;
						}
						count = Number(picked);
					}
				}
			} else if (!prompt) {
				notify(ctx, "Usage: /imagine <prompt>  (interactive pickers need a UI session)", "warning");
				return;
			}

			const progress = startProgress(ctx, `正在生成图片 · ${modelKey ?? "默认模型"}`);
			try {
				const result = await generate(ctx, {
					prompt,
					modelKey,
					count,
					size,
					outputDir,
					cwd: ctx.cwd,
					signal: ctx.signal,
					resolveAuth: (entry) => resolveAuth(ctx, entry),
					onProgress: (message) => progress.setStage(message),
				}, entries);
				const summary = `${result.text}\n(共 ${formatBytes(result.saved.reduce((sum, img) => sum + img.bytes, 0))},耗时 ${progress.elapsed()})`;
				notify(ctx, summary, "info");
			} catch (error) {
				if (ctx.signal?.aborted) notify(ctx, "已取消", "info");
				else notify(ctx, `生图失败(耗时 ${progress.elapsed()}): ${error instanceof Error ? error.message : error}`, "error");
			} finally {
				progress.stop();
			}
		},
	});
}
