import { validateToolArguments, type Tool, type ToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import type { ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import type { FlowLocalTool, FlowRuntime } from './runtime-types.ts';
import type { ActionCatalog } from './tool-catalog.ts';

export type ActionRuntime = FlowRuntime & {
	// Lease only for actual execution (not for the model request or a pending relay).
	withHost?<T>(signal: AbortSignal, fn: (current: ExtensionToolContext) => Promise<T>): Promise<T>;
};

function hasToolHost(ctx: ExtensionContext): ctx is ExtensionToolContext {
	return 'executeTool' in ctx && typeof ctx.executeTool === 'function' && 'tools' in ctx && Array.isArray(ctx.tools);
}

type Outcome = { content: ToolResultMessage['content']; isError?: boolean; terminate?: boolean };
type Execute = (signal: AbortSignal) => Promise<Outcome>;

/** Only a live outer ExtensionToolContext can execute a nested tool. Never copy execute
 * or prepareArguments from the registry; this catalog only contains declarations. */
const control = new Set(['flow_run', 'flow_step', 'flow_continue', 'flow_cancel', 'flow_status']);

export function actionToolset(
	ctx: ExtensionContext,
	required: readonly string[],
	runtime: ActionRuntime | undefined,
	fail: (message: string) => Error,
	catalog: ActionCatalog,
) {
	const handlers = new Map<string, (call: ToolCall) => Execute>();
	const visible = (name: string) => !runtime || (!control.has(name) && runtime.hostToolVisible?.(name) !== false);
	const withHost = runtime?.withHost?.bind(runtime);
	const host = (runtime || required.length) && hasToolHost(ctx) ? ctx : undefined;
	// tools is Pi’s guarded, live registry getter. Never execute on this context after
	// detachment: a long-running Flow leases the currently attached caller via withHost.
	const available = host?.tools.filter((t) => visible(t.name)).map(declare) ?? [];
	const declarations: Tool[] = [];
	const callable = new Map(available.map((t) => [t.name, t]));
	for (const name of runtime ? callable.keys() : required) {
		const tool = callable.get(name);
		if (!tool) continue;
		declarations.push(tool);
		handlers.set(name, (call) => async (s) => {
			const execute = async (current: ExtensionToolContext) => {
				if (!visible(name) || !current.tools.some((t) => t.name === name))
					throw fail(`tool is no longer callable: ${name}`);
				const { result, isError } = await current.executeTool(name, call.arguments, { signal: s });
				return { content: result.content, isError, terminate: result.terminate };
			};
			return withHost ? withHost(s, execute) : execute(host!);
		});
	}
	function registerLocal(tool: FlowLocalTool, dynamic: boolean) {
		if (handlers.has(tool.name)) throw fail(`tool name collision: ${tool.name}`);
		handlers.set(tool.name, (call) => {
			function args(t: FlowLocalTool) {
				try {
					return validateToolArguments(t, call);
				} catch {
					throw fail(`invalid arguments for ${tool.name}`);
				} // Pi's diagnostic may quote private arguments.
			}
			const prepared = args(tool);
			return (s) => {
				if (!dynamic || !runtime?.getLocalTools) return tool.execute(prepared, s);
				const current = runtime.getLocalTools().find((t) => t.name === tool.name);
				if (!current) throw fail(`tool is no longer callable: ${tool.name}`);
				return current.execute(args(current), s);
			};
		});
	}
	for (const tool of runtime?.getLocalTools?.() ?? runtime?.localTools ?? []) {
		registerLocal(tool, true);
		declarations.push(declare(tool));
	}
	for (const name of required) {
		if (!handlers.has(name))
			throw fail(host || withHost ? `tool is not callable: ${name}` : 'tools require a Pi ExtensionToolContext');
	}
	const page = runtime ? catalog.select(declarations, required, ctx.model?.contextWindow) : { tools: declarations };
	if ('search' in page && page.search) {
		const allowed = new Set(page.tools.map((t) => t.name));
		for (const name of handlers.keys()) if (!allowed.has(name)) handlers.delete(name);
		registerLocal(page.search, false);
		page.tools.push(declare(page.search));
	}
	return { declarations: page.tools, handlers };
}

function declare({ name, description, parameters, constrainedSampling }: Tool): Tool {
	return { name, description, parameters, ...(constrainedSampling !== undefined ? { constrainedSampling } : {}) };
}
