import type { AgentToolResult, Theme, ToolDefinition, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth, type Component } from '@earendil-works/pi-tui';
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
export function toolHeading(label: string) {
	return (args: Record<string, unknown>, theme: Theme, ctx: ToolRenderContext) =>
		new Text(
			theme.fg('toolTitle', theme.bold(label)) +
				' ' +
				fmt(args?.name ?? args?.id ?? '') +
				' ' +
				theme.fg('dim', ctx.keyHint('app.tools.expand', '展开/收起')),
			0,
			0,
		);
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
		const data = fallback ?? payload(r);
		if (Array.isArray(data))
			return {
				render: (w) =>
					[
						...(!data.length
							? ['暂无运行']
							: data
									.slice(0, options.expanded ? 40 : 4)
									.map((s) => `${fmt(s.phase)}  ${fmt(s.name)}  ·  ${fmt(s.id)}`)),
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
