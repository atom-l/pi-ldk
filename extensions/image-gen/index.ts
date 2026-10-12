/**
 * pi-image-gen — generate images with multimodal models configured in models.json
 *
 * The plugin claims the custom `imageGeneration` field in pi's models.json
 * (a field pi's schema does not use and passes through untouched) to mark
 * which models can generate images. See README.md for the convention.
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
	generateImages,
	loadImageModels,
	selectModel,
} from "./core.ts";

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
					headers: { ...(resolved.headers ?? {}), ...auth.headers },
				};
			}
		}
	} catch {
		// registry unavailable — fall back to the raw models.json values
	}
	return auth;
}

function describeModels(entries: ImageModelEntry[]): string {
	if (entries.length === 0) return "(no models marked with the \"imageGeneration\" field)";
	return entries
		.map((e) => {
			const tags: string[] = [];
			if (e.gen.default) tags.push("default");
			if (e.gen.promptTemplate) tags.push("promptTemplate");
			if ((e.gen.maxImages ?? 4) > 1) tags.push(`max ${e.gen.maxImages} images`);
			return `${e.key}${tags.length ? ` [${tags.join(", ")}]` : ""}`;
		})
		.join(", ");
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
		Type.String({ description: 'Requested image size, e.g. "1024x1024". Forwarded as image_config.size unless overridden in config.' }),
	),
	referenceImages: Type.Optional(
		Type.Array(Type.String(), {
			description: "Reference images for image-to-image editing: paths relative to the working directory, URLs, or data: URIs.",
		}),
	),
	outputDir: Type.Optional(
		Type.String({ description: "Directory for the generated files (default: generated-images under the working directory)." }),
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
	// Must never throw: a malformed models.json should degrade the tool
	// description, not break extension loading. Execute re-reads config anyway.
	let modelList: string;
	try {
		modelList = describeModels(loadImageModels(process.cwd()));
	} catch (error) {
		modelList = `(models.json could not be read: ${error instanceof Error ? error.message : error})`;
	}

	pi.registerTool({
		name: "generate_image",
		label: "generate image",
		description:
			"Generate (or edit) images with a multimodal image-generation model configured in models.json " +
			'(models marked with the custom "imageGeneration" field). The images are written to disk and their ' +
			`paths are returned. Available image models: ${modelList}. ` +
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

			const result = await generateImages(options);
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
							input: result.usage.input,
							output: result.usage.output,
							cacheRead: result.usage.cacheRead,
							cacheWrite: result.usage.cacheWrite,
							totalTokens: result.usage.totalTokens,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
			const spinner = frames[frame++ % frames.length];
			ctx.ui.setStatus("image-gen", `${title} ${elapsed()}`);
			ctx.ui.setWidget("image-gen-progress", [`${spinner} ${title} — ${elapsed()}`, `   ${stage}`]);
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
					ctx.ui.setWidget("image-gen-progress", undefined);
					ctx.ui.setStatus("image-gen", undefined);
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
			"Flags skip the matching picker (model=provider/id n=2 size=1024x1024 out=dir). /imagine list shows configured models.",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			if (tokens[0] === "list" || tokens[0] === "models") {
				const list = loadImageModels(ctx.cwd);
				const lines = list.map((e) => {
					const cfg = e.gen;
					const parts = [
						cfg.default ? "default" : null,
						cfg.api && cfg.api !== "chat" ? `api=${cfg.api}` : null,
						cfg.promptTemplate ? `promptTemplate=${JSON.stringify(cfg.promptTemplate)}` : null,
						cfg.outputDir ? `outputDir=${cfg.outputDir}` : null,
					].filter(Boolean);
					return `${e.key}${parts.length ? `  (${parts.join(", ")})` : ""}`;
				});
				const message = lines.length
					? `Image models:\n${lines.join("\n")}`
					: 'No image models configured. Mark one in models.json with "imageGeneration": true.';
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

				const entries = loadImageModels(ctx.cwd);
				if (entries.length === 0) {
					notify(ctx, '没有配置生图模型。请在 models.json 里用 "imageGeneration": true 标记一个模型。', "warning");
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

				if (!size) {
					const picked = await ctx.ui.select("选择尺寸", SIZE_CHOICES);
					if (!picked) {
						notify(ctx, "已取消", "info");
						return;
					}
					if (picked.startsWith("自定义")) {
						size = ((await ctx.ui.input("自定义尺寸（如 1280x720）", "1280x720")) ?? "").trim() || undefined;
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
				const result = await generateImages({
					prompt,
					modelKey,
					count,
					size,
					outputDir,
					cwd: ctx.cwd,
					signal: ctx.signal,
					resolveAuth: (entry) => resolveAuth(ctx, entry),
					onProgress: (message) => progress.setStage(message),
				});
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
