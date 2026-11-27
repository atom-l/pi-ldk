import { Type } from 'typebox';
import { Check } from 'typebox/value';

const MAX_QUESTIONS = 24;
const MAX_OPTIONS = 32;
const MAX_OPTION = 160;
const MAX_PROMPT = 2048;
const MAX_TITLE = 160;
const MAX_ID = 64;
export const MAX_TEXT_LENGTH = 4096;

const kinds = ['single', 'multi', 'text'] as const;
const option = Type.String({ minLength: 1, maxLength: MAX_OPTION });
const listBounds = { minItems: 1, maxItems: MAX_OPTIONS, uniqueItems: true };
const questionSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: MAX_ID, description: 'Stable, unique question identifier.' }),
		prompt: Type.String({ minLength: 1, maxLength: MAX_PROMPT }),
		kind: Type.Enum(kinds, { type: 'string' }),
		options: Type.Optional(
			Type.Array(option, { ...listBounds, description: 'Distinct labels for single/multi; omit for text.' }),
		),
		default: Type.Optional(
			Type.Union([Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH }), Type.Array(option, listBounds)], {
				description:
					'Optional prefill, not approval. Text: nonblank string. Single: one exact option. Multi: nonempty list of distinct exact options.',
			}),
		),
		required: Type.Optional(
			Type.Boolean({
				description:
					'Whether an answer is requested (default true). Advisory only: the user can leave any question blank.',
			}),
		),
	},
	{ additionalProperties: false },
);

export const formParams = Type.Object(
	{
		title: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TITLE })),
		questions: Type.Array(questionSchema, { minItems: 1, maxItems: MAX_QUESTIONS, description: 'In display order.' }),
	},
	{ additionalProperties: false },
);

export type Value = string | string[];
export type Question = {
	id: string;
	prompt: string;
	kind: (typeof kinds)[number];
	options?: string[];
	default?: Value;
	required: boolean;
};
export type Form = { title: string; questions: Question[] };
export type Answer = { id: string; prompt: string; value: Value | null; source: 'user' | 'default' | 'skipped' };

// Never echo unvalidated data into a terminal-facing error. Allow LF only in multiline fields;
// reject bidi controls, line/paragraph separators and lone surrogates as well as terminal controls.
const unsafe = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ud800-\udfff]/u;
function safeText(value: string, name: string, max: number, multiline = false): string {
	if (value.length > max * 2 || Array.from(value).length > max) throw new Error(`${name}最长 ${max} 个字符`);
	if (unsafe.test(value) || (!multiline && value.includes('\n'))) throw new Error(`${name}含不支持的控制字符或换行`);
	return value;
}
function label(value: string, name: string, max: number, multiline = false): string {
	safeText(value, name, max, multiline);
	if (!value.trim()) throw new Error(`${name}不能为空白`);
	return value;
}
function empty(value: Value | undefined): boolean {
	return value === undefined || (typeof value === 'string' ? !value.trim() : value.length === 0);
}

/** Validate before storing; multi values are copied in declaration order, not click order. */
function checkedValue(q: Question, value: Value): Value {
	if (q.kind === 'multi') {
		if (!Array.isArray(value) || value.length > q.options!.length) throw new Error('多选答案须为选项列表');
		const selected = new Set(value);
		const ordered = q.options!.filter((o) => selected.has(o));
		if (ordered.length !== value.length) throw new Error('多选答案包含重复或不存在的选项');
		return ordered;
	}
	if (typeof value !== 'string') throw new Error('单选或文本答案须为字符串');
	if (q.kind === 'text') return safeText(value, '文本答案', MAX_TEXT_LENGTH, true);
	if (value !== '' && !q.options!.includes(value)) throw new Error('单选答案不在选项中');
	return value;
}

/** Parse a tool payload without mutating it or inventing IDs, choices or approvals. */
export function parseForm(raw: unknown): Form {
	if (!Check(formParams, raw)) throw new Error('答题卡结构不符，请检查字段类型、数量、长度及选项是否重复');
	const title = label(raw.title ?? '答题卡', '标题', MAX_TITLE);
	const ids = new Set<string>();
	const questions = Array.from(raw.questions, (input, i): Question => {
		const name = `第 ${i + 1} 题`;
		const id = label(input.id, `${name} ID`, MAX_ID);
		if (id.trim() !== id || ids.has(id)) throw new Error(`${name} ID 有首尾空白或重复`);
		ids.add(id);
		const q: Question = {
			id,
			prompt: label(input.prompt, `${name}题干`, MAX_PROMPT, true),
			kind: input.kind,
			required: input.required ?? true,
		};
		if (q.kind === 'text') {
			if (input.options !== undefined) throw new Error(`${name}是文本题，不接受选项`);
		} else {
			if (!input.options) throw new Error(`${name}缺少选项`);
			q.options = Array.from(input.options, (o) => {
				label(o, `${name}选项`, MAX_OPTION);
				if (o.trim() !== o) throw new Error(`${name}选项不得有首尾空白`);
				return o;
			});
		}
		if (input.default !== undefined) {
			q.default = checkedValue(q, input.default);
			if (empty(q.default)) throw new Error(`${name}默认值不能为空白，不预填请省略 default`);
		}
		return q;
	});
	return { title, questions };
}

export class Draft {
	readonly form: Form;
	private readonly edits = new Map<number, Value>();

	constructor(form: Form) {
		this.form = form;
	}

	private question(index: number): Question {
		if (!Number.isInteger(index) || index < 0 || index >= this.form.questions.length) throw new RangeError('题号越界');
		return this.form.questions[index];
	}

	value(index: number): Value | undefined {
		const q = this.question(index);
		const value = this.edits.get(index) ?? q.default;
		return Array.isArray(value) ? [...value] : value;
	}

	// Keep empty edits visible in the editor. Resolve defaults only for preview/submission.
	set(index: number, value: Value): void {
		this.edits.set(index, checkedValue(this.question(index), value));
	}
	reset(): void {
		this.edits.clear();
	}

	answers(): Answer[] {
		return this.form.questions.map(({ id, prompt, default: fallback }, i) => {
			const edit = this.edits.get(i);
			const useEdit = edit !== undefined && !empty(edit);
			const value = useEdit ? edit : fallback;
			if (value === undefined) return { id, prompt, value: null, source: 'skipped' };
			return { id, prompt, value: Array.isArray(value) ? [...value] : value, source: useEdit ? 'user' : 'default' };
		});
	}

	/** Lossless content shared by the preview and submitted result. Layout/scrolling belongs to the UI. */
	preview(): string {
		return [
			this.form.title,
			...this.answers().map(({ id, prompt, value, source }, i) => {
				const state = source === 'default' ? '默认值' : source === 'user' ? '已作答' : '已跳过';
				const text = Array.isArray(value) ? value.map((v) => `• ${v}`).join('\n') : value;
				return `${i + 1}. [${id}] ${prompt}\n【${state}】${text === null ? '' : `\n${text}`}`;
			}),
		].join('\n\n');
	}
}
