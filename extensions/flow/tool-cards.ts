import type { AgentToolResult, Theme, ToolDefinition, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import type { Flow } from './contract.ts';
import { clean, diagramFrom, diagramLines, type Diagram } from './graph-lines.ts';
import { runCard, type RunFrame } from './run-board.ts';
import type { runBook } from './runs.ts';

type ToolRenderContext = Parameters<NonNullable<ToolDefinition['renderCall']>>[2];
type Book = ReturnType<typeof runBook>;
type Display = { frame?: RunFrame; diagram?: Diagram };
const fmt = (s: unknown) => clean(s);
export const toolText = (value: unknown, details: Display = {}, isError = false): AgentToolResult<Display> => ({
	content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
	details: structuredClone(details),
	...(isError ? { isError: true } : {}),
});
function payload(r: AgentToolResult<Display>) {
	const t = r.content.find((x) => x.type === 'text')?.text ?? '';
	try {
		return JSON.parse(t);
	} catch {
		return t;
	}
}

const record = (value: unknown): value is Record<string, any> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const stateLines = (value: unknown) => String(value ?? '').split(/\r\n?|\n/).map((line) => clean(line));
const wrapped = (lines: string[], width: number) =>
	lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width))).map((line) => truncateToWidth(line, width));
const stateTarget = (exit: any) => (exit?.to === null ? '完成' : `→ ${fmt(exit?.to)}`);

/** State runs intentionally have no DAG frame, watcher or legacy run-card fallback. */
function stateRunCard(data: Record<string, any>, expanded: boolean, theme: Theme): Component {
	return {
		render(width) {
			const current = typeof data.current === 'string' ? data.current : null;
			const exits = Array.isArray(data.exits) ? data.exits : [];
			const lines = [
				theme.fg('accent', `State Flow · ${fmt(data.name)} · ${fmt(data.phase)}`),
				`${fmt(data.id)} · revision ${fmt(data.revision)} · 当前 ${current ? fmt(current) : '—'}`,
			];
			if (current) lines.push(`Action  ${fmt(current)}`);
			if (expanded && data.context) lines.push('共同背景', ...stateLines(data.context).map((line) => `  ${line}`));
			if (expanded && current)
				lines.push('当前指令', ...stateLines(data.instruction).map((line) => `  ${line}`));
			if (current || exits.length) {
				lines.push('直接出口');
				for (const exit of exits.slice(0, expanded ? 50 : 3))
					lines.push(
						`  ${stateTarget(exit)} · ${fmt(exit?.when) || '无条件'}${exit?.confirm ? ' · 需用户确认' : ''}`,
					);
				if (exits.length > (expanded ? 50 : 3)) lines.push(`  … 共 ${exits.length} 条出口`);
			}
			if (expanded && data.error) lines.push('错误', ...stateLines(data.error).map((line) => `  ${line}`));
			return wrapped(lines, width);
		},
		invalidate() {},
	};
}

function stateDefinitionCard(
	data: Record<string, any>,
	expanded: boolean,
	theme: Theme,
): Component {
	const definition = record(data.definition) ? data.definition : undefined;
	const flow = data.kind === 'flow';
	const actions = flow && record(definition?.actions) ? definition.actions : {};
	const entries = Object.entries(actions);
	const exits = entries.reduce(
		(total, [, node]) => total + (record(node) && Array.isArray(node.exits) ? node.exits.length : 0),
		0,
	);
	const desc = flow
		? definition
			? `State Flow · ${entries.length} 个状态 · ${exits} 条出口${definition.start ? ` · 起点 ${fmt(definition.start)}` : ''}`
			: 'State Flow · 未返回定义详情'
		: 'State Action · 状态指令';
	return {
		render(width) {
			const lines = [theme.fg('accent', `${data.saved ? '✓ 已保存' : '▣'} ${fmt(data.name)} · ${desc}`)];
			if (expanded && definition?.context)
				lines.push('共同背景', ...stateLines(definition.context).map((line) => `  ${line}`));
			if (expanded && !flow && definition)
				lines.push('指令', ...stateLines(definition.instruction).map((line) => `  ${line}`));
			if (expanded && flow && definition) {
				for (const [id, raw] of entries) {
					if (!record(raw)) continue;
					lines.push(
						`状态 ${fmt(id)}${definition.start === id ? ' · 起点' : ''} · ${
							typeof raw.use === 'string' ? `use ${fmt(raw.use)}` : '内联指令'
						}`,
					);
					if (typeof raw.instruction === 'string')
						lines.push(...stateLines(raw.instruction).map((line) => `  ${line}`));
					for (const exit of Array.isArray(raw.exits) ? raw.exits : [])
						lines.push(
							`  ${stateTarget(exit)} · ${fmt(exit?.when) || '无条件'}${exit?.confirm ? ' · 需用户确认' : ''}`,
						);
				}
			}
			return wrapped(lines, width);
		},
		invalidate() {},
	};
}
export function toolHeading(label: string) {
	return (args: Record<string, unknown>, theme: Theme, ctx: ToolRenderContext) => {
		const text = ctx.lastComponent instanceof Text ? ctx.lastComponent : new Text('', 0, 0);
		text.setText(
			`${theme.fg('toolTitle', theme.bold(label))} ${fmt(args?.name ?? args?.id ?? '')} ${ctx.keyHint('app.tools.expand', '展开/收起')}`,
		);
		return text;
	};
}
export function presentRun(book: Book) {
	return (
		r: AgentToolResult<Display>,
		options: ToolRenderResultOptions,
		theme: Theme,
		ctx: ToolRenderContext,
	): Component => {
		// After a gate/early join, this earlier tool result no longer owns a live Pi caller.
		// Watching only its visual frame lets new events redraw it without executing any tools.
		const fallback = r.details?.frame;
		const body = payload(r);
		const data = record(body) && body.mode === 'state' ? body : fallback ?? body;
		if (record(data) && data.mode === 'state') return stateRunCard(data, options.expanded, theme);
		if (Array.isArray(data))
			return {
				render: (w) =>
					[
						...(!data.length
							? ['暂无运行']
							: data
									.slice(0, options.expanded ? 40 : 4)
									.map((s) =>
										s?.mode === 'state'
											? `${fmt(s.phase)}  ${fmt(s.name)}  ·  ${fmt(s.current ?? '—')}  ·  ${fmt(s.id)} · r${fmt(s.revision)}`
											: `${fmt(s.phase)}  ${fmt(s.name)}  ·  ${fmt(s.id)}`,
									)),
						...(data.length > (options.expanded ? 40 : 4) ? [`… 共 ${data.length} 次运行`] : []),
					].map((s) => truncateToWidth(s, w)),
				invalidate() {},
			};
		// An abort can replace the final tool result with a host error lacking our details.
		const id = typeof data?.id === 'string' ? data.id : ctx.state?.flowRunId;
		if (typeof id !== 'string')
			return new Text(
				theme.fg(ctx.isError ? 'error' : 'muted', fmt(typeof data === 'string' ? data : '暂无运行记录')),
				0,
				0,
			);
		if (ctx.state) ctx.state.flowRunId = id;
		let frame = fallback;
		try {
			frame = book.views.get(id) ?? frame;
		} catch {
			/* e.g. HTML export without a live session */
		}
		frame ??= {
			id,
			name: data?.name ?? id,
			phase: data?.phase ?? 'unknown',
			drained: data?.drained === true,
			pending: data?.pending ?? [],
			steps: Array.isArray(data?.steps) ? data.steps : [],
			error: data?.error ?? (ctx.isError ? fmt(data) : undefined),
			output: data?.output,
		};
		book.views.watch(id, `row:${ctx.toolCallId}`, () => ctx.invalidate());
		return runCard(frame!, options.expanded, theme);
	};
}
export function presentDefinition(
	r: AgentToolResult<Display>,
	{ expanded }: ToolRenderResultOptions,
	theme: Theme,
	ctx: ToolRenderContext,
): Component {
	if (ctx.isError) return new Text(theme.fg('error', fmt(r.content.find((x) => x.type === 'text')?.text)), 0, 0);
	const data = payload(r);
	if (!data || typeof data !== 'object') return new Text(fmt(data), 0, 0);
	if (data.mode === 'state' || data.definition?.mode === 'state')
		return stateDefinitionCard(data, expanded, theme);
	if (Array.isArray(data.names))
		return new Text(
			[
				`${data.kind === 'action' ? 'Action' : 'Flow'} · ${data.names.length} 个定义`,
				...(expanded ? data.names.map((n: string) => `  ▣ ${fmt(n)}`) : []),
			].join('\n'),
			0,
			0,
		);
	const g =
		r.details?.diagram ??
		(data.kind === 'flow' && data.definition?.nodes ? diagramFrom(data.definition as Flow) : undefined);
	const desc = g ? `${g.nodes.length} 个节点 · ${g.edges.length} 条连线` : fmt(data.definition?.extends ?? 'Action');
	return {
		render(w) {
			const lines = [theme.fg('accent', `${data.saved ? '✓ 已保存' : '▣'} ${fmt(data.name)}  ·  ${desc}`)];
			if (expanded && g) lines.push(...diagramLines(g, w, theme, { limit: 12 }));
			if (expanded && !g && data.definition) {
				const a = data.definition;
				for (const k of ['inputs', 'outputs', 'tools', 'template', 'test', 'question', 'join'])
					if (a[k] !== undefined) {
						const v = a[k];
						const value =
							k === 'inputs' || k === 'outputs'
								? Object.entries(v)
										.map(([n, p]) => `${fmt(n)}:${fmt((p as { type: string }).type)}`)
										.join('  ')
								: k === 'join'
									? `${v.waitFor} / ${v.countOn} / ${v.remaining}`
									: Array.isArray(v)
										? v.join(', ')
										: v;
						lines.push(`  ${k}  ${fmt(value)}`);
					}
			}
			return lines.map((s) => truncateToWidth(s, w));
		},
		invalidate() {},
	};
}
