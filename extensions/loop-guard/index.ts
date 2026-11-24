import type { ContextEvent, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Detector, type Hit } from './detector.ts';
import { foldLoop, foldStream } from './fold.ts';
import { notices, notify } from './notices.ts';

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

export default function loopGuard(pi: ExtensionAPI) {
  const detector = new Detector();
  const log = notices(pi);
  let enabled = true, reply = 0, evidenceAt = '', stoppedAt = '', foldReported = false;
  let block = -1, blockChars = 0;
  const location = () => `本次第 ${reply} 次模型回复`;
  let pending: Hit | undefined, offered = false, guided: Hit | undefined;
  let paused = false, guidedTurns = 0;
  let call: {id: string; name: string; arguments: unknown} | undefined;
  let recent: string[] = [], recovery: string[] = [], removed = 0;
  let report = '', streamAnchor: string | undefined, shortened = false;
  let builtins = new Set<string>();
  function clearRun() {
    detector.reset(); pending = guided = call = undefined; offered = paused = false;
    guidedTurns = 0; recent = [];
  }
  function clearSession() { clearRun(); recovery = []; removed = 0; report = ''; streamAnchor = undefined; shortened = false; }
  const remember = (key?: string) => {
    if (key) { recent.push(key); if (recent.length > MAX_ANCHORS) recent.shift(); }
  };
  function stop(hit: Hit, ctx: ExtensionContext, streaming: boolean, where: string) {
    if (paused || ctx.signal?.aborted || ctx.hasPendingMessages()) return;
    paused = true; recovery = recent.slice(); removed = 0; shortened = false;
    streamAnchor = recovery.at(-1)?.startsWith('a:') ? recovery.at(-1) : undefined;
    report = `${streaming ? '同一回复内持续复读，引导尚无投递机会' : '引导后同一模式再次出现'}：${hit.description}`;
    stoppedAt = where; foldReported = false;
    ctx.abort();
    log.mark(ctx, `${where}：循环保护已暂停当前生成。${report}。可补充指令继续，或用 /loopguard restore 保留完整上下文。`);
  }
  function observe(hit: Hit | undefined, ctx: ExtensionContext, stream: boolean, where: string) {
    if (!hit || paused || ctx.signal?.aborted || ctx.hasPendingMessages()) return;
    if (guided?.key === hit.key) return stop(hit, ctx, false, where);
    if (stream && hit.sustained) return stop(hit, ctx, true, where);
    if (pending || guided) return;
    // Start the recovery interval at the evidence, not the beginning of the task.
    recent = hit.toolSteps ? recent.slice(-2*hit.toolSteps) : [];
    pending = hit; evidenceAt = where; // suspicion alone is silent
  }

  function leaveBranch() { clearSession(); log.reset(); reply = 0; }
  pi.on('session_start', () => { enabled = true; leaveBranch(); });
  pi.on('session_shutdown', leaveBranch);
  pi.on('session_tree', leaveBranch);
  pi.on('session_compact', clearSession);
  pi.on('model_select', clearRun);
  pi.on('before_agent_start', () => {
    clearRun();
    if (!enabled) return;
    builtins = new Set(pi.getAllTools().filter(t => t.sourceInfo.source === 'builtin' && t.sourceInfo.path === `builtin:${t.name}`).map(t => t.name));
  });
  pi.on('agent_settled', (_event, ctx) => { log.finish(ctx); clearRun(); reply = 0; });
  pi.on('message_start', ({message}, ctx) => {
    if (!enabled) return;
    if (message.role === 'user') { clearRun(); return; }
    if (message.role !== 'assistant' || paused) return;
    reply++; block = -1; blockChars = 0;
    if (offered && pending) {
      guided = pending; offered = false; pending = undefined; guidedTurns = 0; detector.reset();
      log.mark(ctx, `${location()}开始：已加入策略引导。依据：${evidenceAt}，${guided.description}。`);
    } else if (guided && ++guidedTurns >= (guided.toolSteps ?? 1)) {
      // The next full observation window did not reproduce the guided loop.
      // A later revisit needs a fresh guide, not a stale automatic pause.
      guided = undefined;
    }
    detector.newMessage();
  });
  pi.on('message_update', ({assistantMessageEvent: e, message}, ctx) => {
    if (!enabled || paused || (e.type !== 'text_delta' && e.type !== 'thinking_delta')) return;
    if (block !== e.contentIndex) {
      block = e.contentIndex; blockChars = 0; detector.newMessage();
      // Do not turn repeated reasoning in a completed block into an intervention
      // after the model has already moved to its answer or another content block.
      if (pending && !pending.toolSteps) pending = undefined;
    }
    // Count Unicode code points incrementally; do not rescan the cumulative message.
    for (const _char of e.delta) blockChars++;
    const hit = detector.delta(e.delta, e.type === 'text_delta' ? 'text' : 'thinking');
    // The stream may be aborted before its final content is persisted. Pin its identity,
    // not its partial contents. An ambiguous/missing anchor always means no folding.
    if (hit && (hit.sustained || guided?.key === hit.key)) remember(anchor(message));
    if (hit) observe(hit, ctx, true, `${location()} · ${e.type === 'text_delta' ? '正文' : '思考'}块 ${block+1}（已输出 ${blockChars} 字符）`);
  });
  pi.on('message_end', ({message: m}, ctx) => {
    if (!enabled || paused) return;
    if (m.role === 'assistant') {
      remember(anchor(m));
      const calls = m.content.filter(b => b.type === 'toolCall');
      call = calls.length === 1 ? calls[0] : undefined;
      if (calls.length && pending && !pending.toolSteps) pending = undefined; // A new tool decision supersedes stale prose.
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
      const hit = detector.tool(c.name, c.arguments, m.content[0].text, m.isError);
      if (hit) observe(hit, ctx, false, `${location()} · ${c.name} 工具结果`);
    }
  });
  pi.on('context', ({messages}, ctx) => {
    // Pi can project one more context while an aborted turn is unwinding;
    // that is not a recovery request and must not consume the recovery notice.
    if (!enabled || paused || ctx.signal?.aborted) return;
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
        if (!foldReported && (removed || shortened)) {
          foldReported = true;
          log.mark(ctx, `第 ${reply+1} 次模型请求前：已折叠此前暂停处的重复上下文（${stoppedAt}）。原始记录未改写。`);
        }
      } else { removed = 0; shortened = false; }
    }
    if (pending && !paused && !ctx.signal?.aborted && !ctx.hasPendingMessages()) {
      offered = true;
      out = [...out, {role:'custom', customType:GUIDE, display:false, timestamp:Date.now(),
        content:`循环保护提示（不是用户指令）：${pending.description}。如果这是用户要求的重复验证或确有新进展，请按原任务继续；否则请改用能检验新假设的方法，缺少信息时告知用户。`}];
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
      notify(ctx, `循环保护${enabled ? '开启' : '关闭'}。${report ? `最近暂停：${stoppedAt}，${report}。最近一次请求折叠 ${removed} 条重复工具消息${shortened ? '，并缩短了重复回复' : ''}。` : '无暂停记录。'}`);
    },
  });
}
