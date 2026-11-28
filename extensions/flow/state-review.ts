import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

// The stock select title is wrapped, but may be taller than the terminal. Keep
// a read-only, scrollable copy; closing this view can never approve an edge.
export async function reviewText(ctx: ExtensionContext, text: string, signal: AbortSignal) {
	await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
		let top = 0, page = 1, previousWidth = -1, lines: string[] = [];
		const stop = () => done();
		signal.addEventListener('abort', stop, { once: true });
		if (signal.aborted) stop();
		return {
			capturesViewportInput: true,
			render(width) {
				if (width < 1) return [];
				if (width !== previousWidth) {
					lines = wrapTextWithAnsi(text, width);
					previousWidth = width;
				}
				page = Math.max(1, tui.terminal.rows - 6);
				top = Math.max(0, Math.min(top, lines.length - page));
				return [...lines.slice(top, top + page), truncateToWidth(`↑↓/Pg 翻页 · Esc 返回（不批准） ${top + 1}/${lines.length}`, width)];
			},
			handleInput(key) {
				if (matchesKey(key, Key.escape)) return stop();
				if (matchesKey(key, Key.down)) top++;
				else if (matchesKey(key, Key.up)) top--;
				else if (matchesKey(key, Key.pageDown)) top += page;
				else if (matchesKey(key, Key.pageUp)) top -= page;
				else if (matchesKey(key, Key.home)) top = 0;
				else if (matchesKey(key, Key.end)) top = lines.length;
				else return;
				tui.requestRender();
			},
			invalidate() { previousWidth = -1; },
			dispose() { signal.removeEventListener('abort', stop); },
		};
	}, { blocked: { kind: 'permission', message: '查看此次 Flow 方案全文' } });
}
