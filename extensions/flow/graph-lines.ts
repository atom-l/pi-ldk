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

type Card = Diagram['nodes'][number] & {
	x: number;
	width: number;
	anchor: number;
	feeds: Set<string>;
	exit: boolean;
};
type Row = { level: number; cards: Card[]; rail?: string };

/** Register only routes that can be drawn without implying a false junction.
 * The same anchors drive the borders, the rail and the card's hit rectangle. */
function connectRows(above: Row, below: Row, links: Map<string, Flow['edges']>, width: number) {
	const pairs = above.cards.flatMap((a) =>
		below.cards.flatMap((b) => (links.get(a.id)?.some((e) => e.to[0] === b.id) ? [{ a, b }] : [])),
	);
	if (!pairs.length) return;
	// Group edges that share a card. A single horizontal trunk is truthful for
	// a star; independent trunks may share this row only if their spans are disjoint.
	const buses = [];
	while (pairs.length) {
		const group = [pairs.pop()!];
		for (const edge of group) {
			for (let i = pairs.length - 1; i >= 0; i--) {
				if (pairs[i].a === edge.a || pairs[i].b === edge.b) group.push(pairs.splice(i, 1)[0]);
			}
		}
		const anchors = group.flatMap(({ a, b }) => [a.anchor, b.anchor]);
		const star = group.every((e) => e.a === group[0].a) || group.every((e) => e.b === group[0].b);
		buses.push({ group, star, lo: Math.min(...anchors), hi: Math.max(...anchors) });
	}
	const cells = new Uint8Array(width); // up=1, right=2, down=4, left=8
	let drawn = false;
	for (const bus of buses) {
		if (!bus.star || buses.some((other) => other !== bus && other.lo <= bus.hi && bus.lo <= other.hi)) continue;
		for (const { a, b } of bus.group) {
			a.exit = true;
			b.feeds.add(a.id);
			cells[a.anchor] |= 1;
			cells[b.anchor] |= 4;
		}
		for (let x = bus.lo; x < bus.hi; x++) {
			cells[x] |= 2;
			cells[x + 1] |= 8;
		}
		drawn = true;
	}
	if (drawn) {
		const glyphs = ' ╵╶└╷│┌├╴┘─┴┐┤┬┼';
		below.rail = Array.from(cells, (bits) => glyphs[bits])
			.join('')
			.trimEnd();
	}
}

function border(card: Card, top: boolean): string {
	const socket = top ? card.feeds.size > 0 : card.exit;
	const anchor = card.anchor - card.x;
	const bar = socket
		? '─'.repeat(anchor - 1) + (top ? '┴' : '┬') + '─'.repeat(card.width - anchor - 2)
		: '─'.repeat(card.width - 2);
	return top ? `╭${bar}╮` : `╰${bar}╯`;
}

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
	const incoming = new Map(nodes.map((n) => [n.id, [] as Flow['edges']]));
	const degree = new Map(nodes.map((n) => [n.id, 0]));
	for (const e of edges) {
		links.get(e.from[0])?.push(e);
		incoming.get(e.to[0])?.push(e);
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
	// Lay out *physical* rows first, including wrapping and the limit window. Any
	// spare column is assigned to a real card, not silently lost between two rails.
	const layout: Row[] = [];
	for (let i = 0; i < visible.length; ) {
		const level = visible[i].level,
			chunk: typeof visible = [];
		while (i < visible.length && visible[i].level === level && chunk.length < columns) chunk.push(visible[i++]);
		const space = width - 2 * (chunk.length - 1);
		const row: Row = {
			level,
			cards: chunk.map((n, j) => {
				const left = Math.floor((j * space) / chunk.length),
					w = Math.floor(((j + 1) * space) / chunk.length) - left,
					x = left + 2 * j;
				return { ...n, x, width: w, anchor: x + Math.floor(w / 2), feeds: new Set(), exit: false };
			}),
		};
		const previous = layout.at(-1);
		if (width >= 8 && level >= 0 && previous && previous.level < level) connectRows(previous, row, links, width);
		layout.push(row);
	}
	if (first) out.push(dim(`↑ 另有 ${first} 个节点`));
	for (const { level, cards: row, rail } of layout) {
		if (rail) out.push(dim(rail));
		const rowStart = out.length;
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
					[clean(n.kind), badge ? clean(badge) : '', level < 0 ? '未排序' : `第 ${level + 1} 层`]
						.filter(Boolean)
						.join(' · '),
				),
			];
			// An off-row or crossing wire must not appear attached to a neighbouring card.
			const remote = incoming.get(n.id)?.filter((e) => !n.feeds.has(e.from[0])) ?? [];
			if (remote.length) {
				const e = remote[0];
				rows.push(
					dim(
						`↰ ${clean(e.from[0])}.${clean(e.from[1])} → ${clean(e.to[1])}${remote.length > 1 ? ` (+${remote.length - 1})` : ''}`,
					),
				);
			}
			for (const e of destinations.slice(0, 3))
				rows.push(dim(`↳ ${clean(e.from[1])} → ${clean(e.to[0])}.${clean(e.to[1])}`));
			if (destinations.length > 3) rows.push(dim(`… 另有 ${destinations.length - 3} 条连线`));
			return rows;
		});
		if (width < 8) {
			out.push(...cards[0].map((s) => cut(s, width)));
			opts.onCard?.(row[0].id, rowStart, out.length - 1, 0, width);
			continue;
		}
		out.push(row.map((n) => dim(border(n, true))).join('  '));
		for (let j = 0; j < Math.max(...cards.map((c) => c.length)); j++)
			out.push(
				cards
					.map((c, k) => {
						const w = row[k].width,
							s = cut(c[j] ?? '', w - 4);
						return `${dim('│')} ${s}${' '.repeat(Math.max(0, w - 4 - visibleWidth(s)))} ${dim('│')}`;
					})
					.join('  '),
			);
		out.push(row.map((n) => dim(border(n, false))).join('  '));
		row.forEach((n) => opts.onCard?.(n.id, rowStart, out.length - 1, n.x, n.width));
	}
	if (first + visible.length < sorted.length) out.push(dim(`↓ 另有 ${sorted.length - first - visible.length} 个节点`));
	return out.map((s) => truncateToWidth(s, width, '…'));
}
