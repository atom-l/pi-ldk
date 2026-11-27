import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { clean, diagramFrom, diagramLines } from './graph-lines.ts';
import type { Flow, Port, Resolved } from './contract.ts';

export type BoardKey = 'exit' | 'menu' | 'save' | 'add' | 'edit' | 'link' | 'unlink' | 'local' | 'jump';
export type Board = { selected?: string; page: number; detail: boolean; error?: string; dirty: boolean };
const clip = (line: string, width: number) => truncateToWidth(line, Math.max(0, width), '…');
export const errorText = (e: unknown) => clean(e instanceof Error ? e.message : e);
export const edgeText = (e: Flow['edges'][number]) => `${e.from.map(clean).join('.')} → ${e.to.map(clean).join('.')}`;

function portLines(ports: Record<string, Port>, indent = ''): string[] {
	return Object.entries(ports).flatMap(([id, p]) => [
		`${indent}${clean(id)} : ${p.type}`,
		...(p.fields ? portLines(p.fields, indent + '  ') : []),
	]);
}

export function properties(r: Resolved): string[] {
	const lines = [`类型  ${r.kind}`, '输入端口', ...portLines(r.inputs, '  '), '输出端口', ...portLines(r.outputs, '  ')];
	for (const [label, value] of [
		['模板', r.template],
		['条件', r.test],
		['问题', r.question],
	] as const) {
		if (value) lines.push(`${label}  ${clean(value)}`);
	}
	if (r.tools) lines.push(`工具  ${r.tools.map(clean).join(' · ') || '无'}`);
	if (r.join) lines.push(`汇合  waitFor=${r.join.waitFor} · ${r.join.countOn} · ${r.join.remaining}`);
	return lines;
}

function details(flow: Flow, id: string | undefined, resolve: (id: string) => Resolved) {
	if (id === undefined) return { lines: ['没有节点'], hints: [] };
	const use = flow.nodes[id].use;
	const lines = [
		`${typeof use === 'string' ? '引用' : '内联继承'}  ${clean(typeof use === 'string' ? use : use?.extends)}`,
	];
	const hints: string[] = [];
	try {
		const r = resolve(id);
		lines.push(...properties(r));
		for (const [label, ports] of [
			['输入', r.inputs],
			['输出', r.outputs],
		] as const) {
			const entries = Object.entries(ports),
				first = entries[0];
			hints.push(
				`${label}  ${first ? `${clean(first[0])} : ${first[1].type}` : '—'}${entries.length > 1 ? ` · 另 ${entries.length - 1} 个` : ''}`,
			);
		}
	} catch (e) {
		lines.push(`⚠ ${errorText(e)}`);
	}
	lines.push('相邻连线');
	for (const e of flow.edges) if (e.from[0] === id || e.to[0] === id) lines.push(`  ${edgeText(e)}`);
	return { lines, hints };
}

type Card = { id: string; first: number; last: number; x: number; columns: number };
const wrapped = (lines: string[], width: number) => lines.flatMap((s) => wrapTextWithAnsi(s, Math.max(1, width)));

/** Return intents before opening native dialogs, so Pi restores focus before each transition. */
export async function boardScreen(
	ctx: ExtensionCommandContext,
	flow: Flow,
	state: Board,
	readonly: boolean,
	resolve: (id: string) => Resolved,
	root = '',
) {
	const graph = diagramFrom(flow),
		ids = graph.nodes.map((n) => n.id);
	for (const n of graph.nodes) {
		try {
			n.kind = resolve(n.id).kind;
		} catch {
			/* keep unresolved reference visible in invalid drafts */
		}
	}
	let i = Math.max(0, ids.indexOf(state.selected ?? ''));
	state.selected = ids[i];
	return ctx.ui.custom<BoardKey>(
		(tui, theme, kb, done) => {
			let cache: { width: number; rows: number; lines: string[]; hits: Card[] } | undefined;
			let drawing:
				| {
						width: number;
						id?: string;
						detail: boolean;
						content: string[];
						cards: Card[];
						right: string[];
						hints: string[];
				  }
				| undefined;
			let capacity = 1,
				maxPage = 0,
				followSelected = true;
			const invalidate = () => {
				cache = undefined;
				drawing = undefined;
			};
			const repaint = () => {
				cache = undefined;
				tui.requestRender();
			};
			const scroll = (by: number) => {
				followSelected = false;
				state.page = Math.max(0, Math.min(maxPage, state.page + by));
				repaint();
			};
			const select = (index: number) => {
				i = index;
				state.selected = ids[i];
				followSelected = true;
			};
			return {
				capturesViewportInput: true,
				invalidate,
				render(width) {
					const rows = Math.max(1, tui.terminal.rows);
					if (cache?.width === width && cache.rows === rows) return cache.lines;
					if (width < 1) {
						cache = undefined;
						return [''];
					}
					const title = theme.fg(
						'accent',
						`Flow 工作台 · ${clean(flow.name)} · ${readonly ? '只读' : state.dirty ? '未保存 ●' : '编辑'}${root ? ` · ${clean(root)}` : ''}`,
					);
					const caption = theme.fg(
						'muted',
						`${state.detail ? '节点详情' : '节点'} ${ids.length ? i + 1 : 0}/${ids.length}  ❯ ${clean(state.selected ?? '—')}   ·   ${graph.edges.length} 条连线`,
					);
					const header = rows >= 4 ? [title, caption] : rows >= 2 ? [caption] : [];
					if (state.error && rows >= 5) header.push(theme.fg('error', '⚠ ' + state.error));
					const legend = state.detail
						? `Esc 返回 · ↑↓/滚轮 滚动${readonly ? '' : ' · e 属性 · m 操作 · s 保存'}`
						: `↑↓/点击 节点 · Enter 详情 · m 操作${readonly ? '' : ' · s 保存'} · Esc 退出 · PgUp/Dn/滚轮 翻页`;
					const footer =
						rows < 3
							? []
							: wrapped([legend], width)
									.slice(0, rows >= 12 ? 2 : 1)
									.map((s) => theme.fg('dim', s));
					const side = !state.detail && width >= 78;
					const left = side ? Math.floor(width * 0.62) : width;
					if (
						!drawing ||
						drawing.width !== width ||
						drawing.id !== state.selected ||
						drawing.detail !== state.detail
					) {
						const cards: Card[] = [],
							inspector = details(flow, state.selected, resolve);
						const content = state.detail
							? wrapped(inspector.lines, width)
							: diagramLines(graph, left, theme, {
									selected: state.selected,
									onCard: (id, first, last, x, columns) => cards.push({ id, first, last, x, columns }),
								});
						drawing = {
							width,
							id: state.selected,
							detail: state.detail,
							content,
							cards,
							right: side ? wrapped(inspector.lines, width - left - 3) : [],
							hints: inspector.hints,
						};
					}
					const { content, cards, right } = drawing;
					const hints = !side && !state.detail && rows >= 12 ? drawing.hints.map((s) => theme.fg('muted', s)) : [];
					capacity = Math.max(1, rows - header.length - footer.length - hints.length);
					maxPage = Math.max(0, content.length - capacity);
					if (followSelected && !state.detail) {
						const c = cards.find((c) => c.id === state.selected);
						if (c) {
							if (c.last - c.first + 1 > capacity) {
								// If even the card won't fit, keep its name rather than just the border.
								state.page = c.first + (capacity === 1 && c.columns >= 8 ? 1 : 0);
							} else if (c.first < state.page) state.page = c.first;
							else if (c.last >= state.page + capacity) state.page = c.last - capacity + 1;
						}
					}
					state.page = Math.max(0, Math.min(state.page, maxPage));
					const hits: Card[] = [];
					for (const c of cards) {
						const first = Math.max(0, c.first - state.page),
							last = Math.min(capacity - 1, c.last - state.page);
						if (first <= last) hits.push({ ...c, first: header.length + first, last: header.length + last });
					}
					const body = content.slice(state.page, state.page + capacity);
					while (body.length < capacity) body.push('');
					if (side)
						for (let n = 0; n < body.length; n++) {
							const a = clip(body[n], left);
							body[n] =
								a +
								' '.repeat(Math.max(0, left - visibleWidth(a))) +
								theme.fg('dim', ' │ ') +
								(right[n] ?? '');
						}
					if (maxPage > 0 && rows >= 4)
						header[1] += theme.fg(
							'dim',
							`   行 ${state.page + 1}–${Math.min(content.length, state.page + capacity)}/${content.length}`,
						);
					const lines = [...header, ...body, ...hints, ...footer].map((line) => clip(line, width));
					cache = { width, rows, lines, hits };
					return lines;
				},
				handleMouse(event) {
					if (event.type === 'wheel' && event.wheelDelta) {
						scroll(event.wheelDelta);
						return { handled: true, render: false };
					}
					if (event.button !== 'left' || (event.type !== 'press' && event.type !== 'click')) return;
					const hit = cache?.hits.find(
						(c) => event.y >= c.first && event.y <= c.last && event.x >= c.x && event.x < c.x + c.columns,
					);
					if (!hit) return;
					// Pi synthesizes click on release at the press location (not after dragging).
					if (event.type === 'click') {
						select(ids.indexOf(hit.id));
						repaint();
					}
					return { handled: true, render: false };
				},
				handleInput(data: string) {
					if (isKeyRelease(data)) return;
					if (kb.matches(data, 'tui.select.cancel')) {
						if (!state.detail) return done('exit');
						state.detail = false;
						followSelected = true;
						state.page = 0;
					} else if (kb.matches(data, 'tui.select.confirm')) {
						if (state.detail || !ids.length) return done('menu');
						state.detail = true;
						state.page = 0;
					} else if (kb.matches(data, 'tui.select.up') || kb.matches(data, 'tui.select.down')) {
						const d = kb.matches(data, 'tui.select.up') ? -1 : 1;
						if (state.detail) return scroll(d);
						select(Math.max(0, Math.min(ids.length - 1, i + d)));
					} else if (matchesKey(data, 'pageUp')) return scroll(-capacity);
					else if (matchesKey(data, 'pageDown')) return scroll(capacity);
					else if (matchesKey(data, 'm')) return done('menu');
					else if (matchesKey(data, 'j')) return done('jump');
					else if (matchesKey(data, 'c')) return done('local');
					else if (!readonly && (matchesKey(data, 's') || matchesKey(data, 'ctrl+s'))) return done('save');
					else if (!readonly && matchesKey(data, 'e')) return done('edit');
					else if (!readonly && matchesKey(data, 'a')) return done('add');
					else if (!readonly && matchesKey(data, 'l')) return done('link');
					else if (!readonly && matchesKey(data, 'x')) return done('unlink');
					else return;
					repaint();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { width: '100%', maxHeight: '100%' },
			blocked: { kind: 'question', message: 'Flow 工作台' },
		},
	);
}
