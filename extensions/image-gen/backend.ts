import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ImageApi, ImageModel, ImagesInputContent } from '@earendil-works/pi-ai';
import { isAbsolute } from 'node:path';
import { applyPromptTemplate, downloadImage, formatBytes, generateLegacy, loadImageModels, resolveReferenceImage, saveImages, selectModel, type GenerateOptions, type GenerateResult, type ImageModelEntry, type RawImage } from './core.ts';

export interface Choice extends ImageModelEntry { native?: ImageModel<ImageApi>; legacy: boolean }
export async function catalog(ctx: ExtensionContext): Promise<Choice[]> {
  const disabled = new Set<string>();
  // Legacy entries retain order and hence implicit defaults. Never read a project
  // overlay for registry authentication; the registry resolves its own credentials.
  const list: Choice[] = loadImageModels(ctx.cwd, process.env, disabled).map(e => ({ ...e, legacy:true }));
  const registry = ctx.modelRegistry;
  if (typeof registry?.getAvailableOfType !== 'function' || typeof registry.generateImages !== 'function') return list;
  const entries = new Map(list.map(e => [e.key,e]));
  let available: readonly ImageModel<ImageApi>[];
  try { available = await registry.getAvailableOfType('image', undefined, {signal:ctx.signal}); }
  catch (error) {
    // Discovery did not issue a generation request. An unavailable catalogue
    // must not break an otherwise usable legacy-only installation.
    if (!list.length || ctx.signal?.aborted) throw error;
    return list;
  }
  for (const model of available) {
    const key = `${model.provider}/${model.id}`;
    if (disabled.has(key)) continue;
    const existing = entries.get(key);
    if (existing) existing.native = model;
    else entries.set(key, { key, provider:model.provider, modelId:model.id, native:model, legacy:false,
      api:model.api, baseUrl:'', headers:{}, gen:{maxImages:1} });
  }
  return [...entries.values()];
}
function customTransport(e: Choice) {
  const g=e.gen;
  const differentEndpoint = e.baseUrl && e.native?.baseUrl && e.baseUrl.replace(/\/+$/, '') !== e.native.baseUrl.replace(/\/+$/, '');
  return differentEndpoint || Object.keys(e.headers).length || g.api || g.endpoint || g.authStyle || g.systemPrompt || Object.keys(g.request ?? {}).length || Object.keys(e.samplingParams ?? {}).length;
}
export function preferredBackend(e: Choice) { return e.native && !customTransport(e) ? 'native' : 'legacy'; }

export async function generate(ctx: ExtensionContext, opts: GenerateOptions, choices?: Choice[]): Promise<GenerateResult> {
  opts.signal?.throwIfAborted();
  const selection = selectModel(choices ?? await catalog(ctx), opts.modelKey, opts.env);
  if (!selection.entry) throw new Error(selection.error);
  const entry = selection.entry as Choice, model = entry.native;
  const special = opts.size || (opts.count !== undefined && opts.count !== 1) ||
    (opts.referenceImages?.length && model && !model.input.includes('image'));
  // Choose exactly once before any request. A provider error may already have
  // consumed credits; do not retry the operation on another backend.
  if (opts.count !== undefined && (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > (entry.legacy ? entry.gen.maxImages ?? 4 : 1))) {
    throw new Error(`Requested count is not supported by ${entry.key} (max ${entry.legacy ? entry.gen.maxImages ?? 4 : 1})`);
  }
  if (entry.legacy && (!model || customTransport(entry) || special)) return generateLegacy(opts,entry);
  if (!model) throw new Error(`Image model ${entry.key} is unavailable`);
  if (special) throw new Error('原生图片接口仅支持默认尺寸、一次单张；参考图需要支持图片输入的模型。若需自定义参数，请配置旧 imageGeneration 后端。');
  const outputDir=opts.outputDir ?? entry.gen.outputDir ?? 'generated-images';
  if (!isAbsolute(outputDir) && outputDir.split(/[\\/]/).includes('..')) throw new Error('Invalid outputDir: relative paths must not contain ".."');
  const timeout=AbortSignal.timeout(entry.gen.timeoutMs ?? 300000);
  const signal=opts.signal ? AbortSignal.any([opts.signal,timeout]) : timeout;
  const input: ImagesInputContent[]=[{type:'text',text:applyPromptTemplate(entry.gen.promptTemplate,opts.prompt)}];
  for (const ref of opts.referenceImages ?? []) {
    signal.throwIfAborted();
    if (/^https?:\/\//i.test(ref)) {
      const img=await downloadImage(ref,signal); input.push({type:'image',...img});
    } else {
      const {dataUri}=await resolveReferenceImage(ref,opts.cwd);
      const match=/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i.exec(dataUri);
      if (!match) throw new Error('Expected a base64 image data URI or an image path');
      input.push({type:'image',mimeType:match[1],data:match[2]});
    }
  }
  signal.throwIfAborted();
  opts.onProgress?.(`Using ${entry.key} to generate 1 image (Pi registry)...`);
  const result=await ctx.modelRegistry.generateImages(model,{input},{signal,maxRetries:0});
  signal.throwIfAborted();
  if (result.stopReason!=='stop') throw new Error(result.errorMessage || `Image request ${result.stopReason}`);
  const raw: RawImage[]=result.output.flatMap(b=>b.type==='image'?[{kind:'b64' as const,data:b.data,mimeType:b.mimeType}]:[]);
  if (!raw.length) throw new Error('Native image model returned no image');
  const {saved,errors}=await saveImages(raw,{cwd:opts.cwd,outputDir,fileName:opts.fileName,prompt:opts.prompt,signal});
  if (!saved.length) throw new Error(`Could not save generated image: ${errors.join('; ')}`);
  return {entry,saved,errors,usage:result.usage,text:[`Generated ${saved.length} image(s) with ${entry.key}:`,
    ...saved.map(i=>`- ${i.path} (${formatBytes(i.bytes)}, ${i.mimeType})`), ...errors].join('\n')};
}
