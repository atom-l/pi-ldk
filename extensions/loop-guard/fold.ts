import { createHash } from 'node:crypto';
import type { ContextEvent } from '@earendil-works/pi-coding-agent';

type Messages = ContextEvent['messages'];
const READ_ONLY = new Set(['read', 'ls', 'grep', 'find']);
interface Pair { index: number; signature: string }

// A streaming stop may leave just one enormous assistant message, not a run of
// tool pairs. Only touch confirmed, unsigned plain prose. Match an exact repeated
// suffix including its final partial period; cap both input and candidate work.
export function foldStream(m: Messages[number]): Messages[number] {
  if (m.role !== 'assistant' || m.content.length !== 1 || m.deferred || m.diagnostics?.length) return m;
  const block = m.content[0];
  if (block.type !== 'text' || Object.keys(block).some(k => k !== 'type' && k !== 'text')) return m;
  const s = block.text;
  if (s.length < 240 || s.length > 262144 || /```|~~~|^\s*[|>#]/m.test(s)) return m;
  const end = s.length, marker = s.slice(-64);
  let pos = end-65;
  for (let attempts=0;pos>=0 && attempts<32;attempts++) {
    pos = s.lastIndexOf(marker,pos);
    if (pos<0) break;
    const period=end-64-pos;
    if (period>8192) break;
    if (period>=48) {
      let start=pos;
      while (start>0 && s.charCodeAt(start-1)===s.charCodeAt(start-1+period)) start--;
      const copies=Math.floor((end-start)/period);
      if (copies>=4 && new Set(s.slice(start,start+period)).size>=8) {
        const skip=(copies-2)*period;
        return {...m,content:[{type:'text',text:s.slice(0,start+period)+`\n[循环保护：省略 ${copies-2} 段逐字相同的回复]\n`+s.slice(start+period+skip)}]};
      }
    }
    pos--;
  }
  return m;
}

// Only unsigned single read-only tool calls followed immediately by their exact
// result. Nothing is removed across a user message, parallel batch, new result,
// assistant narration, image, unknown block, nested call or provider signature.
function pair(messages: Messages, index: number): Pair | undefined {
  const m = messages[index], r = messages[index+1];
  if (m?.role !== 'assistant' || m.stopReason !== 'toolUse' || m.content.length !== 1 ||
      m.errorMessage || m.diagnostics?.length || m.deferred || r?.role !== 'toolResult' || r.nestedCalls) return;
  const c = m.content[0];
  if (c.type !== 'toolCall' || !READ_ONLY.has(c.name) || c.name !== r.toolName || c.id !== r.toolCallId ||
      Object.keys(c).some(k => !['type','id','name','arguments'].includes(k)) ||
      r.content.some(b => b.type !== 'text' || Object.keys(b).some(k => k !== 'type' && k !== 'text'))) return;
  if (r.content.reduce((size,b) => size+(b.type === 'text' ? b.text.length : 0),0) > 131072) return;
  const data = JSON.stringify([m.provider,m.model,m.responseModel,m.api,c.name,c.arguments,r.isError,r.content,r.details]);
  return {index,signature:createHash('sha256').update(data).digest('hex')};
}

export function foldLoop(messages: Messages, start: number, end: number): {messages: Messages; removed: number} {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start<0 || end>messages.length || end<=start || end-start>64)
    return {messages,removed:0};
  let out: Messages | undefined, cursor = 0, removed = 0;
  // Each match is an uninterrupted run of >=3 exact copies of an entire unit.
  // Preserve the first and last complete unit; leave the rest of the transcript alone.
  for (let i=start; i+5<end;) {
    const pairs: Pair[] = [];
    for (let j=i;j+1<end;j+=2) { const p=pair(messages,j); if (!p) break; pairs.push(p); }
    if (!pairs.length) { i++; continue; }
    let n=0;
    while (n<pairs.length) {
      let matched=false;
      for (let p=1;p<=6 && n+3*p<=pairs.length;p++) {
        let length=p;
        while(n+length<pairs.length && pairs[n+length].signature===pairs[n+(length%p)].signature) length++;
        const copies=Math.floor(length/p);
        if(copies<3) continue;
        const left=pairs[n+p].index, right=pairs[n+(copies-1)*p].index;
        out = (out ?? []).concat(messages.slice(cursor,left));
        out.push({role:'custom',customType:'ldk-loop-fold',display:false,timestamp:messages[left].timestamp,
          content:`循环保护记录：此处省略了 ${copies-2} 轮完全相同的只读工具调用及其结果；首次与末次证据均保留。`});
        cursor=right; removed+=right-left; n+=copies*p; matched=true; break;
      }
      if(!matched) n++;
    }
    i+=2*pairs.length;
  }
  if(!out) return {messages,removed:0};
  // concat rather than spreading a potentially large untouched transcript.
  return {messages:out.concat(messages.slice(cursor)),removed};
}
