import type { Theme } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Compiled, Flow } from './contract.ts';

// A topology snapshot deliberately contains no instructions, tools or message values.
export type Diagram = { nodes: { id: string; kind: string }[]; edges: Flow['edges'] };
export function clean(value: unknown): string {
	const text = typeof value === 'string' ? value : value == null ? '' : typeof value === 'object' ? '…' : String(value);
	return stripTerminalSequences(text).replace(
		/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ud800-\udfff]/gu,
		' ',
	);
}
export function diagramFrom(flow: Flow | Compiled): Diagram {
	return {
		nodes: Object.entries(flow.nodes).map(([id, node]) => {
			const ref = 'kind' in node ? node.kind : typeof node.use === 'string' ? node.use : node.use?.extends;
			return { id, kind: typeof ref === 'string' ? ref.replace(/^builtin:/, '') : '未知引用' };
		}),
		edges: flow.edges,
	};
}
const symbols: Record<string, string> = {
	start: '◎',
	end: '◉',
	task: '▣',
	action: '▣',
	decision: '◇',
	gate: '⚑',
	fork: '⑂',
	join: '⋈',
};
const glyph = (kind: string) => (Object.hasOwn(symbols, kind) ? symbols[kind] : '▣');

/** Draw node cards by dependency level. Outgoing routes carry the *actual* port names;
 * cards placed side by side need not be connected. Invalid/cyclic drafts remain editable. */
export function diagramLines(
	graph: Diagram,
	width: number,
	theme: Theme,
	opts: {
		selected?: string;
		badges?: ReadonlyMap<string, string>;
		limit?: number;
		onCard?: (id: string, firstLine: number, lastLine: number, x: number, columns: number) => void;
	} = {},
): string[] {
	if (!(width >= 1)) return [];
	width = Math.floor(width);
	const { nodes, edges } = graph;
	if (!nodes.length) return [truncateToWidth(theme.fg('dim', '（尚无节点）'), width)];
	const links = new Map(nodes.map((n) => [n.id, [] as Flow['edges']]));
	const degree = new Map(nodes.map((n) => [n.id, 0]));
	for (const e of edges) {
		links.get(e.from[0])?.push(e);
		if (links.has(e.from[0]) && degree.has(e.to[0])) degree.set(e.to[0], degree.get(e.to[0])! + 1);
	}
	const queue = nodes.filter((n) => !degree.get(n.id)).map((n) => n.id),
		levels = new Map<string, number>();
	for (const id of queue) levels.set(id, 0);
	for (let i = 0; i < queue.length; i++) {
		const id = queue[i];
		for (const {
			to: [next],
		} of links.get(id)!) {
			if (!degree.has(next)) continue;
			levels.set(next, Math.max(levels.get(next) ?? 0, levels.get(id)! + 1));
			const left = degree.get(next)! - 1;
			degree.set(next, left);
			if (!left) queue.push(next);
		}
	}
	const bands = new Map<number, typeof nodes>();
	for (const n of nodes) {
		const level = degree.get(n.id) ? -1 : (levels.get(n.id) ?? 0);
		const group = bands.get(level);
		if (group) group.push(n);
		else bands.set(level, [n]);
	}
	const sorted = [...bands.keys()]
		.sort((a, b) => (a < 0 ? Infinity : a) - (b < 0 ? Infinity : b))
		.flatMap((level) => bands.get(level)!.map((n) => ({ level, ...n })));
	const cap = Math.max(1, opts.limit ?? sorted.length),
		at = sorted.findIndex((n) => n.id === opts.selected);
	const first = Math.max(0, Math.min(Math.max(0, sorted.length - cap), at - Math.floor(cap / 2)));
	const visible = sorted.slice(first, first + cap);
	const out: string[] = [];
	const dim = (s: string) => theme.fg('dim', s),
		cut = (s: string, w: number) => truncateToWidth(s, Math.max(0, w), '…');
	const columns = width >= 88 ? 3 : width >= 50 ? 2 : 1;
	let priorRow: typeof visible = [];
	// Only draw a shared rail for an actual fan-out/fan-in; unrelated branches
	// must not look connected. Non-adjacent edges remain labeled on their source.
	function rail(row: typeof visible) {
		const center = (i: number, len: number) => {
			const w = Math.floor((width - 2 * (len - 1)) / len);
			return i * (w + 2) + Math.floor(w / 2);
		};
		const pairs = priorRow.flatMap((n, i) =>
			row.flatMap((m, j) => ((links.get(n.id) ?? []).some((e) => e.to[0] === m.id) ? [[i, j]] : [])),
		);
		if (!pairs.length || (new Set(pairs.map((p) => p[0])).size > 1 && new Set(pairs.map((p) => p[1])).size > 1)) return;
		const cells = Array<number>(width).fill(0); // up, right, down, left
		for (const [i, j] of pairs) {
			const a = center(i, priorRow.length),
				b = center(j, row.length);
			cells[a] |= 1;
			cells[b] |= 4;
			for (let x = Math.min(a, b); x < Math.max(a, b); x++) {
				cells[x] |= 2;
				cells[x + 1] |= 8;
			}
		}
		const glyphs = ' ╵╶└╷│┌├╴┘─┴┐┤┬┼';
		out.push(
			dim(
				cells
					.map((v) => glyphs[v])
					.join('')
					.trimEnd(),
			),
		);
	}
	if (first) out.push(dim(`↑ 另有 ${first} 个节点`));
	for (let i = 0; i < visible.length; ) {
		const level = visible[i].level;
		out.push(dim(level < 0 ? '┄ 未排序（草稿中有环或悬空连接）' : `┄ 第 ${level + 1} 层`));
		let firstRow = true;
		while (i < visible.length && visible[i].level === level) {
			const row: typeof visible = [];
			while (i < visible.length && visible[i].level === level && row.length < columns) row.push(visible[i++]);
			if (firstRow && level >= 0 && width >= 8) rail(row);
			firstRow = false;
			priorRow = row;
			const w = Math.floor((width - 2 * (row.length - 1)) / row.length),
				rowStart = out.length;
			const cards = row.map((n) => {
				const active = n.id === opts.selected,
					badge = opts.badges?.get(n.id);
				const destinations = links.get(n.id) ?? [];
				const head = `${active ? '▸ ' : ''}${glyph(n.kind)} ${clean(n.id)}`;
				const rows = [
					active ? theme.fg('accent', head) : theme.bold(head),
					theme.fg(
						badge?.startsWith('failed')
							? 'error'
							: badge?.startsWith('done')
								? 'success'
								: badge === 'waiting'
									? 'warning'
									: badge === 'started'
										? 'accent'
										: 'muted',
						[clean(n.kind), badge ? clean(badge) : ''].filter(Boolean).join(' · '),
					),
				];
				for (const e of destinations.slice(0, 3))
					rows.push(dim(`↳ ${clean(e.from[1])} → ${clean(e.to[0])}.${clean(e.to[1])}`));
				if (destinations.length > 3) rows.push(dim(`… 另有 ${destinations.length - 3} 条连线`));
				return rows;
			});
			if (w < 8) {
				out.push(...cards[0].map((s) => cut(s, w)));
				opts.onCard?.(row[0].id, rowStart, out.length - 1, 0, w);
				continue;
			}
			const bar = '─'.repeat(w - 2);
			out.push(row.map(() => dim(`╭${bar}╮`)).join('  '));
			for (let j = 0; j < Math.max(...cards.map((c) => c.length)); j++)
				out.push(
					cards
						.map((c) => {
							const s = cut(c[j] ?? '', w - 4);
							return `${dim('│')} ${s}${' '.repeat(Math.max(0, w - 4 - visibleWidth(s)))} ${dim('│')}`;
						})
						.join('  '),
				);
			out.push(row.map(() => dim(`╰${bar}╯`)).join('  '));
			row.forEach((n, i) => opts.onCard?.(n.id, rowStart, out.length - 1, i * (w + 2), w));
		}
	}
	if (first + visible.length < sorted.length) out.push(dim(`↓ 另有 ${sorted.length - first - visible.length} 个节点`));
	return out.map((s) => truncateToWidth(s, width, '…'));
}
