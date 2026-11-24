import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

const TYPE = 'ldk-loop-intervention';
export function notify(ctx: ExtensionContext, text: string, warn = false) {
  if (ctx.hasUI) ctx.ui.notify(text, warn ? 'warning' : 'info');
  else console.error(text); // Keep JSON/print stdout machine-readable.
}

// Live notice at the intervention; one chat-only receipt after the entire response
// settles (including abort). Neither is an assistant message or starts a new turn.
export function notices(pi: ExtensionAPI) {
  let first: string[] = [], last = '', count = 0;
  pi.registerEntryRenderer<{text:string}>(TYPE, (entry, _options, theme) => {
    if (typeof entry.data?.text === 'string') return new Text(theme.fg('dim', entry.data.text), 0, 0);
  });
  function reset() { first = []; last = ''; count = 0; }
  return {reset,
    mark(ctx: ExtensionContext, line: string) {
      count++; if (first.length < 6) first.push(line); last = line;
      notify(ctx, `循环保护介入 · ${line}`, true);
    },
    finish(ctx: ExtensionContext) {
      if (!count) return;
      const lines = count <= first.length ? first : [...first, ...(count>7 ? [`中间另有 ${count-7} 次，已实时提示。`] : []), last];
      const text = `循环保护 · 本次介入记录\n${lines.join('\n')}`;
      reset();
      pi.appendEntry(TYPE, {text});
      if (ctx.mode !== 'tui') notify(ctx, text);
    },
  };
}
