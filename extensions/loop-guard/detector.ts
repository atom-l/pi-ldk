import { createHash } from 'node:crypto';

export interface Hit { key: string; description: string; toolSteps?: number; sustained?: boolean }
const READ_ONLY = new Set(['read', 'ls', 'grep', 'find']);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const CAP = 6144, STRIDE = 128;
const structured = /^(?:\s*(?:```|~~~|[|>#{<]|!?\[|"|[-+*]\s|\d+[.)]\s)|\t| {4})/;
const delimited = /^(?:[^,\t]*[,\t]){2}/;
// Lexical structure is not prose evidence. This deliberately recognizes only
// cheap, unambiguous shapes; no language parsing or semantic classification.
const isStructured = (s: string) => structured.test(s) || delimited.test(s);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(k => [k,canonical((value as Record<string,unknown>)[k])]));
  return value;
}

// Return the smallest full cycle matching at the tail. Give all rotations the
// same key, so re-entering A/B at B/A is still the same incident.
function cycle(seq: string[], min: number, max: number, rounds=3) {
  for (let p=min;p<=max && rounds*p<=seq.length;p++) {
    const tail=seq.slice(-rounds*p);
    if (!tail.slice(p).every((v,i)=>v===tail[i])) continue;
    const unit=tail.slice(0,p);
    const key=unit.map((_,i)=>unit.slice(i).concat(unit.slice(0,i)).join(':')).sort()[0];
    return {key:digest(key),period:p,rounds};
  }
}

// Minimum cyclic rotation in linear time. A token boundary is not part of a fingerprint.
function rotation(s: string) {
  const n=s.length, ss=s+s; let a=0,b=1,k=0;
  while (a<n && b<n && k<n) {
    if (ss[a+k]===ss[b+k]) { k++; continue; }
    if (ss[a+k]>ss[b+k]) { a+=k+1; if (a===b) a++; }
    else { b+=k+1; if (b===a) b++; }
    k=0;
  }
  const at=Math.min(a,b); return ss.slice(at,at+n);
}

// Prefix-function on the reversed tail: prefixes of length 3*p and 6*p prove
// three and six complete copies at the end. Linear even on a row of dashes.
function repeatedSuffix(s: string): {key:string; period:number; sustained?:boolean} | undefined {
  const n=s.length, prefix=new Uint16Array(n);
  let candidate: {key:string; period:number} | undefined;
  for (let i=1;i<n;i++) {
    let j=prefix[i-1]; const c=s.charCodeAt(n-1-i);
    while (j && c!==s.charCodeAt(n-1-j)) j=prefix[j-1];
    if (c===s.charCodeAt(n-1-j)) j++;
    prefix[i]=j;
    const length=i+1, p=length-j;
    if (candidate && length===6*candidate.period && p===candidate.period)
      return {...candidate,sustained:true};
    if (!candidate && p>=48 && length===3*p) {
      const unit=s.slice(-p);
      if (new Set(unit).size>=8) candidate={key:digest(rotation(unit)),period:p};
    }
  }
  return candidate;
}

class StreamWindow {
  line=''; private prefix=''; private length=0; private fence=''; private lines: string[]=[];
  private raw: string[]=[]; private period: ReturnType<typeof repeatedSuffix>;
  feed(text: string, label: string): Hit | undefined {
    let hit: Hit | undefined, kind: 'period'|'lines'|undefined, next='';
    let row=0, hitRow=0;
    const periodHit=(r: NonNullable<ReturnType<typeof repeatedSuffix>>) => {
      this.period=r; kind='period'; hitRow=row; next='';
      hit={key:`${label}:period:${r.key}`,description:`${label}中同一段无换行内容至少连续重复 ${r.sustained?6:3} 次`,
        ...(r.sustained?{sustained:true}:{})};
    };
    for (let i=0;i<text.length;) {
      const nl=text.indexOf('\n',i), end=nl<0?text.length:nl;
      while (i<end) {
        const stop=Math.min(end, i+STRIDE-(this.length%STRIDE));
        const slice=text.slice(i,stop); i=stop; this.length+=slice.length;
        if (this.prefix.length<96) this.prefix=(this.prefix+slice).slice(0,96);
        this.line=(this.line+slice).slice(-CAP);
        if (this.length>=144 && this.length%STRIDE===0 && !this.fence && !isStructured(this.prefix)) {
          const r=repeatedSuffix(this.line);
          if (r) periodHit(r);
          else { this.period=undefined; if (kind==='period') hit=undefined; }
        }
      }
      if (nl<0) break;
      i++;
      if (hit && kind==='period' && hitRow===row) {
        const r=repeatedSuffix(this.line);
        if (r) periodHit(r); else hit=undefined;
      }
      const fence=this.prefix.trimStart().match(/^(`{3,}|~{3,})/)?.[0];
      if (this.fence || fence) {
        if (!this.fence) this.fence=fence!;
        else if (fence?.startsWith(this.fence) && this.line.trim()===fence) this.fence='';
        this.lines=[]; this.raw=[]; hit=undefined;
      } else {
        const trimmed=this.line.trim();
        if (this.length<=CAP && trimmed.length>=48 && new Set(trimmed).size>=8 && !isStructured(this.line)) {
          this.lines.push(digest(trimmed)); if (this.lines.length>24) this.lines.shift();
          this.raw.push(trimmed); if (this.raw.length>4) this.raw.shift();
          const c=cycle(this.lines,1,4,6) ?? cycle(this.lines,1,4);
          if (c) {
            kind='lines'; hitRow=row; next=this.raw[this.raw.length-c.period];
            hit={key:`${label}:lines:${c.key}`,description:`${label}中周期为 ${c.period} 行的内容连续重复 ${c.rounds} 轮`,
              ...(c.rounds===6?{sustained:true}:{})};
          } else if (kind!=='period' || hitRow!==row) hit=undefined;
        } else if (!trimmed && this.lines.length) {
          // Preserve a paragraph separator as part of the pattern, never as a
          // hit by itself. A/B separated once differs from an entire repeated paragraph.
          this.lines.push('blank'); if (this.lines.length>24) this.lines.shift();
          this.raw.push(''); if (this.raw.length>4) this.raw.shift(); hit=undefined;
        } else {
          this.lines=[]; this.raw=[]; hit=undefined;
        }
      }
      this.period=undefined; this.line=this.prefix=''; this.length=0; row++;
    }
    // A later part of the same delta may disprove a hit found at a stride.
    if (hit && kind==='period' && row!==hitRow && (row!==hitRow+1 || this.length!==0)) hit=undefined;
    if ((hit && kind==='period' && row===hitRow) ||
        (!hit && this.period && !this.period.sustained && this.length>=6*this.period.period)) {
      const r=!this.fence && !isStructured(this.prefix) ? repeatedSuffix(this.line) : undefined;
      if (r) periodHit(r); else { this.period=undefined; hit=undefined; }
    }
    // A partial next line is not progress until it disagrees with the cycle.
    if (hit && kind==='lines' && this.length>0 && !next.startsWith(this.line.trim())) hit=undefined;
    return hit;
  }
}

export class Detector {
  private tools: string[]=[];
  private text=new StreamWindow(); private think=new StreamWindow();
  tool(name: string,args: unknown,result: string,isError: boolean): Hit | undefined {
    if (!isError && !READ_ONLY.has(name)) { this.tools=[]; return; }
    const signature=digest(JSON.stringify([name,canonical(args),isError,digest(result)]));
    this.tools.push(signature); if (this.tools.length>18) this.tools.shift();
    const need=isError?3:4;
    if (this.tools.length>=need && this.tools.slice(-need).every(s=>s===signature)) return {
      key:`tool:${signature}`, toolSteps:need, description:isError ? `工具 ${name} 以相同参数反复失败，连续 ${need} 次返回相同错误` :
        `只读工具 ${name} 连续 ${need} 次以相同参数返回相同结果`,
    };
    const c=cycle(this.tools,2,6);
    if (c) return {key:`tools:${c.key}`,toolSteps:3*c.period,description:`包含 ${name}、周期为 ${c.period} 的工具决策连续重复 3 轮，每步结果均相同`};
  }
  delta(text: string,channel: 'text'|'thinking'): Hit | undefined {
    return channel==='text'?this.text.feed(text,'回复'):this.think.feed(text,'思考');
  }
  newMessage() { this.text=new StreamWindow(); this.think=new StreamWindow(); }
  reset() { this.tools=[]; this.newMessage(); }
}
