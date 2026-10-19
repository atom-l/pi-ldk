/**
 * insights — 子会话经验记忆的存储与检索(轻量 RAG),随会话绑定。
 *
 * 设计目标:类 RAG 的召回 / 回溯,但不依赖额外模型调用,要求快:
 *   - 内存倒排索引 + BM25 打分,单次检索微秒~毫秒级;
 *   - 中英混合分词:拉丁词整词,CJK 取一元 + 二元 gram;
 *   - 纯内存索引,不做任何文件 IO:记录随会话文件 custom entry 持久化
 *     (见 index.ts 的 recordInsights),session_start / session_tree 时按
 *     当前分支重放重建 —— 各会话的经验互相隔离,删除会话文件即删除其经验;
 *   - 每条记录带来源(子会话名 / agent / 时间),支持回溯到产出它的上下文。
 *
 * 记录内容即"结果"与"额外信息":kind= "result" 是任务完成的结论,
 * 其余 kind(approach / anomaly / lesson / finding / decision / note)
 * 是处理过程中的解决方式、异常、经验等,供后续任务主动获得启发。
 */

export type InsightKind = "result" | "approach" | "anomaly" | "lesson" | "finding" | "decision" | "note";

export const INSIGHT_KINDS: InsightKind[] = ["result", "approach", "anomaly", "lesson", "finding", "decision", "note"];

export interface InsightRecord {
	id: string;
	kind: InsightKind;
	/** 短标签,通常是产出它的子会话标题。 */
	title: string;
	/** 记录正文:结论或一条经验。 */
	text: string;
	/** 来源标识:子会话名或 "manual"。 */
	source: string;
	agent?: string;
	/** 记录产生时的工作目录:仅作出处展示,不参与检索过滤(会话已天然隔离)。 */
	cwd: string;
	timestamp: number;
}

export interface InsightHit {
	record: InsightRecord;
	score: number;
	/** 命中的词项,便于解释"为什么召回"。 */
	matched: string[];
}

export interface InsightSearchOptions {
	limit?: number;
	kinds?: InsightKind[];
	/** 最低分数,低于该值不返回。 */
	minScore?: number;
}

// ---------------------------------------------------------------------------
// 分词
// ---------------------------------------------------------------------------

const TOKEN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[a-zA-Z0-9_]+/gu;

/** 拉丁词整词;CJK 串拆成一元 + 二元 gram,使中文短语可以部分匹配。 */
export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	const lower = text.toLowerCase();
	for (const chunk of lower.match(TOKEN_RE) ?? []) {
		if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(chunk)) {
			for (let i = 0; i < chunk.length; i++) {
				tokens.push(chunk[i]);
				if (i + 1 < chunk.length) tokens.push(chunk.slice(i, i + 2));
			}
		} else {
			tokens.push(chunk);
		}
	}
	return tokens;
}

// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

const K1 = 1.2;
const B = 0.75;

/** 纯内存经验索引:内容由调用方从会话 custom entry 重放恢复,自身不做文件 IO。 */
export class InsightStore {
	private records: InsightRecord[] = [];
	/** record id -> term -> tf */
	private termFreq = new Map<string, Map<string, number>>();
	private docLen = new Map<string, number>();
	private seq = 0;

	get size(): number {
		return this.records.length;
	}

	/** 清空索引(session_start / session_tree 重建前调用,保证不残留上一分支的经验)。 */
	clear(): void {
		this.records = [];
		this.termFreq.clear();
		this.docLen.clear();
	}

	private indexRecord(record: InsightRecord): void {
		const freq = new Map<string, number>();
		const tokens = tokenize(`${record.title} ${record.kind} ${record.text}`);
		for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
		this.records.push(record);
		this.termFreq.set(record.id, freq);
		this.docLen.set(record.id, tokens.length);
	}

	nextId(): string {
		this.seq += 1;
		// 随机段避免 store 重建 / 多进程在同一毫秒内产生相同 id(重放会按 id 去重而丢记录)。
		const rand = Math.random().toString(36).slice(2, 7).padEnd(5, "0");
		return `ins-${Date.now().toString(36)}-${this.seq.toString(36)}-${rand}`;
	}

	/** 更新内存索引(纯内存,无文件 IO);按 id 去重,保证会话重建重放幂等。 */
	add(records: InsightRecord[]): void {
		for (const record of records) {
			if (!record?.id || this.termFreq.has(record.id)) continue;
			this.indexRecord(record);
		}
	}

	/** BM25 检索。快:纯内存打分,无模型调用;语料即本会话的全部经验。 */
	search(query: string, options: InsightSearchOptions = {}): InsightHit[] {
		const limit = Math.max(1, Math.min(50, options.limit ?? 6));
		const queryTokens = [...new Set(tokenize(query))];
		if (queryTokens.length === 0) return [];
		const corpus = this.records;
		if (corpus.length === 0) return [];
		const kinds = options.kinds?.length ? new Set(options.kinds) : undefined;
		const df = new Map<string, number>();
		for (const token of queryTokens) {
			let count = 0;
			for (const record of corpus) {
				if (this.termFreq.get(record.id)?.has(token)) count++;
			}
			df.set(token, count);
		}
		const avgLen =
			corpus.reduce((sum, record) => sum + (this.docLen.get(record.id) ?? 0), 0) / Math.max(1, corpus.length);

		const hits: InsightHit[] = [];
		for (const record of corpus) {
			if (kinds && !kinds.has(record.kind)) continue;
			const freq = this.termFreq.get(record.id);
			if (!freq) continue;
			const len = this.docLen.get(record.id) ?? 0;
			let score = 0;
			const matched: string[] = [];
			for (const token of queryTokens) {
				const tf = freq.get(token);
				if (!tf) continue;
				const n = corpus.length;
				const d = df.get(token) ?? 0;
				const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
				score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * len) / Math.max(1, avgLen)));
				matched.push(token);
			}
			if (score > 0 && matched.length > 0 && score >= (options.minScore ?? 0)) {
				hits.push({ record, score, matched });
			}
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, limit);
	}
}
