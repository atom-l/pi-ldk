import type { ContextEvent, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Detector, type Hit } from './detector.ts';
import { foldLoop, foldStream } from './fold.ts';

type Message = ContextEvent['messages'][number];
const GUIDE = 'ldk-loop-guide';
const MAX_ANCHORS = 64;

// Never locate a recovery range by array offsets carried across requests. Compaction,
// tree navigation and other extensions may have changed the projection in between.
function anchor(m: Message): string | undefined {
  if (m.role === 'toolResult') return `r:${m.timestamp}:${m.toolCallId}`;
  if (m.role === 'assistant') return `a:${m.timestamp}:${m.content.find(b => b.type === 'toolCall')?.id ?? ''}`;
  return undefined;
}
function notify(ctx: ExtensionContext, text: string, warn = false) {
  if (ctx.hasUI) ctx.ui.notify(text, warn ? 'warning' : 'info');
  else console.error(text); // Never corrupt print/json stdout.
}

export default function loopGuard(pi: ExtensionAPI) {
  const detector = new Detector();
  let enabled = true;
  let pending: Hit | undefined, offered = false, guided: Hit | undefined;
  let streamKey: string | undefined, paused = false, guidedTurns = 0;
  let call: {id: string; name: string; arguments: unknown} | undefined;
  let recent: string[] = [], recovery: string[] = [], removed = 0;
  let report = '', streamAnchor: string | undefined, shortened = false;
  let builtins = new Set<string>();
  function clearRun() {
    detector.reset(); pending = guided = call = undefined; offered = paused = false;
    streamKey = undefined; guidedTurns = 0; recent = [];
  }
  function clearSession() { clearRun(); recovery = []; removed = 0; report = ''; streamAnchor = undefined; shortened = false; }
  const remember = (key?: string) => {
    if (key) { recent.push(key); if (recent.length > MAX_ANCHORS) recent.shift(); }
  };
  function stop(hit: Hit, ctx: ExtensionContext, streaming: boolean) {
    if (paused || ctx.signal?.aborted || ctx.hasPendingMessages()) return;
    paused = true; recovery = recent.slice(); removed = 0; shortened = false;
    streamAnchor = recovery.at(-1)?.startsWith('a:') ? recovery.at(-1) : undefined;
    report = `${streaming ? '同一回复内持续复读，引导尚无投递机会' : '引导后同一模式再次出现'}：${hit.description}`;
    ctx.abort();
    notify(ctx, `循环保护已暂停当前生成。${report}。原始历史未修改；可补充指令继续，或先用 /loopguard restore 保留完整上下文。`, true);
  }
  function observe(hit: Hit | undefined, ctx: ExtensionContext, stream: boolean) {
    if (!hit || paused || ctx.signal?.aborted || ctx.hasPendingMessages()) return;
    if (guided?.key === hit.key) return stop(hit, ctx, false);
    if (stream && streamKey === hit.key) return stop(hit, ctx, true);
    if (stream) { streamKey = hit.key; detector.newMessage(); } // require fresh streaming evidence
    if (pending || guided) return;
    // Start the recovery interval at the evidence, not the beginning of the task.
    recent = hit.toolSteps ? recent.slice(-2*hit.toolSteps) : [];
    pending = hit;
    notify(ctx, `循环保护：${hit.description}。若有下一轮，将提示模型换一种验证方式。`, true);
  }

  pi.on('session_start', () => { enabled = true; clearSession(); });
  pi.on('session_shutdown', clearSession);
  pi.on('session_tree', clearSession);
  pi.on('session_compact', clearSession);
  pi.on('model_select', clearRun);
  pi.on('before_agent_start', () => {
    clearRun();
    builtins = new Set(pi.getAllTools().filter(t => t.sourceInfo.source === 'builtin' && t.sourceInfo.path === `builtin:${t.name}`).map(t => t.name));
  });
  pi.on('agent_settled', clearRun);
  pi.on('message_start', ({message}) => {
    if (!enabled) return;
    if (message.role === 'user') { clearRun(); return; }
    if (message.role !== 'assistant' || paused) return;
    if (offered && pending) {
      guided = pending; offered = false; pending = undefined; guidedTurns = 0; detector.reset();
    } else if (guided && ++guidedTurns > 16) { guided = undefined; detector.reset(); }
    streamKey = undefined; detector.newMessage();
  });
  pi.on('message_update', ({assistantMessageEvent: e, message}, ctx) => {
    if (!enabled || paused || (e.type !== 'text_delta' && e.type !== 'thinking_delta')) return;
    const hit = detector.delta(e.delta, e.type === 'text_delta' ? 'text' : 'thinking');
    // The stream may be aborted before its final content is persisted. Pin its identity,
    // not its partial contents. An ambiguous/missing anchor always means no folding.
    if (hit && (streamKey === hit.key || guided?.key === hit.key)) remember(anchor(message));
    observe(hit, ctx, true);
  });
  pi.on('message_end', ({message: m}, ctx) => {
    if (!enabled || paused) return;
    if (m.role === 'assistant') {
      remember(anchor(m));
      const calls = m.content.filter(b => b.type === 'toolCall');
      call = calls.length === 1 ? calls[0] : undefined;
      // Parallel siblings do not represent repeated autonomous decisions.
      if (calls.length > 1) clearRun();
    } else if (m.role === 'toolResult') {
      const c = call; call = undefined;
      if (!c || c.id !== m.toolCallId || c.name !== m.toolName || m.nestedCalls ||
          m.content.length !== 1 || m.content[0].type !== 'text') { clearRun(); return; }
      remember(anchor(m));
      // A successful shell/plugin action may advance external state even if it always
      // prints "OK". Do not carry a pending accusation (or recovery range) across it.
      if ((!m.isError && !['read','ls','grep','find'].includes(c.name)) || !builtins.has(c.name)) { clearRun(); return; }
      observe(detector.tool(c.name, c.arguments, m.content[0].text, m.isError), ctx, false);
    }
  });
  pi.on('context', ({messages}, ctx) => {
    if (!enabled) return;
    let out = messages;
    if (recovery.length > 0) {
      // Require an exact, unique, contiguous run of anchored messages. Never
      // fold a different branch, a user steering message, or an inserted custom entry.
      const keys = messages.map(anchor), at = keys.indexOf(recovery[0]);
      if (at >= 0 && keys.lastIndexOf(recovery[0]) === at && recovery.every((key,i) => keys[at+i] === key)) {
        const last = at+recovery.length-1;
        shortened = false;
        if (streamAnchor && keys[last] === streamAnchor) {
          const m = foldStream(messages[last]);
          if (m !== messages[last]) { out = messages.slice(); out[last] = m; shortened = true; }
        }
        const folded = foldLoop(out, at, last+1);
        out = folded.messages; removed = folded.removed;
      } else { removed = 0; shortened = false; }
    }
    if (pending && !paused && !ctx.hasPendingMessages()) {
      offered = true;
      out = [...out, {role:'custom', customType:GUIDE, display:false, timestamp:Date.now(),
        content:`循环保护提示（不是用户指令）：${pending.description}。不要再做相同尝试。请验证一个尚未验证的假设；如果缺少信息，请停止并向用户说明。`}];
    }
    return out === messages ? undefined : {messages:out};
  });
  pi.registerCommand('loopguard', {
    description:'循环保护：status | off | on | restore',
    handler: async (args, ctx) => {
      switch (args.trim() || 'status') {
        case 'off': enabled = false; clearSession(); break;
        case 'on': enabled = true; break;
        case 'restore': clearSession(); break;
        case 'status': break;
        default: notify(ctx,'用法：/loopguard status | off | on | restore'); return;
      }
      notify(ctx, `循环保护${enabled ? '开启' : '关闭'}。${report ? `最近暂停：${report}。最近一次请求折叠 ${removed} 条重复工具消息${shortened ? '，并缩短了重复回复' : ''}。` : '无暂停记录。'}`);
    },
  });
}
