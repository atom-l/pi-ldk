// State Flows describe the main conversation's work, not a DAG of executable templates.
// A reusable Action supplies instructions; the Flow owns its edges and confirmation policy.

export type Exit = { to: string | null; when: string; confirm?: boolean };
export type StateAction = { mode: 'state'; instruction: string };
export type StateNode = { instruction: string; exits: Exit[] };
export type StatePlan = {
	mode: 'state';
	name: string;
	context: string;
	start: string;
	actions: Record<string, StateNode>;
};

// Explicit, conservative upper bounds. These bound memory, prompt size and the
// cost of reachability analysis; they are deliberately generous for authors but
// closed against abuse. Kept here so the contract is the single source of truth.
export const LIMITS = {
	name: 120,
	when: 2000,
	instruction: 20000,
	context: 40000,
	states: 256,
	exits: 64,
	planBytes: 512 * 1024,
} as const;

// Prose may contain tabs and line breaks (LF or CRLF), but not terminal/bidi controls.
const UNSAFE_TEXT = /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function fail(where: string, message: string): never {
	throw new Error(`${where}: ${message}`);
}

function record(v: unknown, where: string): Record<string, unknown> {
	if (
		!v ||
		typeof v !== 'object' ||
		Array.isArray(v) ||
		(Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
	) {
		fail(where, 'expected a JSON object');
	}
	return v as Record<string, unknown>;
}

function keys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(where, `unknown property ${k}`);
}

// Dictionaries here are handed to other JS consumers (plans, prompt sections),
// so reserved/prototype keys are refused up front.
function safeKey(k: string, where: string): string {
	if (k === '__proto__' || k === 'prototype' || Object.hasOwn(Object.prototype, k)) fail(where, `reserved name ${k}`);
	return k;
}

function line(v: unknown, where: string, max: number): string {
	if (typeof v !== 'string') fail(where, 'expected string');
	if (!v.trim()) fail(where, 'expected nonempty string');
	if (UNSAFE_TEXT.test(v) || /[\u2028\u2029]/u.test(v)) fail(where, 'control characters are not allowed');
	if (v !== v.trim()) fail(where, 'outer whitespace is not allowed');
	if (v.length > max) fail(where, `too long (limit ${max})`);
	return v;
}

function prose(v: unknown, where: string, max: number, required = true): string {
	if (typeof v !== 'string') fail(where, 'expected string');
	if (required && !v.trim()) fail(where, 'expected nonempty string');
	if (UNSAFE_TEXT.test(v.replace(/\r\n|[\n\t]/g, ''))) fail(where, 'control characters are not allowed');
	if (v.length > max) fail(where, `too long (limit ${max})`);
	return v;
}

/** Cheap, non-throwing discriminant used by the host to route a saved
 * definition to the state machine instead of the legacy DAG. */
export function isStateDefinition(value: unknown): boolean {
	return (
		!!value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		(value as { mode?: unknown }).mode === 'state'
	);
}

/** Validate and normalize a global state Action: `{ mode:'state', instruction }`.
 * Returns a fresh, detached object. Exits are never part of a global Action. */
export function validateStateAction(raw: unknown): StateAction {
	const obj = record(raw, 'action');
	keys(obj, ['mode', 'instruction'], 'action');
	if (obj.mode !== 'state') fail('action.mode', "expected 'state'");
	return { mode: 'state', instruction: prose(obj.instruction, 'action.instruction', LIMITS.instruction) };
}

function readExit(raw: unknown, where: string): Exit {
	const obj = record(raw, where);
	keys(obj, ['to', 'when', 'confirm'], where);
	let to: string | null;
	if (obj.to === null) to = null;
	else if (typeof obj.to === 'string') to = line(obj.to, `${where}.to`, LIMITS.name);
	else fail(`${where}.to`, 'expected string target or null for completion');
	const when = prose(obj.when, `${where}.when`, LIMITS.when);
	const exit: Exit = { to, when };
	if (Object.hasOwn(obj, 'confirm')) {
		if (typeof obj.confirm !== 'boolean') fail(`${where}.confirm`, 'expected boolean');
		if (obj.confirm) exit.confirm = true;
	}
	return exit;
}

function readExits(raw: unknown, where: string): Exit[] {
	if (!Array.isArray(raw)) fail(where, 'expected an array of exits');
	if (raw.length === 0) fail(where, 'a state needs at least one exit');
	if (raw.length > LIMITS.exits) fail(where, `too many exits (limit ${LIMITS.exits})`);
	const exits: Exit[] = [];
	const seen = new Set<string | null>();
	for (const [i, item] of raw.entries()) {
		const exit = readExit(item, `${where}[${i}]`);
		if (seen.has(exit.to)) fail(`${where}[${i}]`, `duplicate exit target ${exit.to === null ? '(completion)' : exit.to}`);
		seen.add(exit.to);
		exits.push(exit);
	}
	return exits;
}

function readNode(raw: unknown, where: string, resolveGlobal?: (name: string) => unknown): StateNode {
	const obj = record(raw, where);
	const inline = Object.hasOwn(obj, 'instruction');
	const ref = Object.hasOwn(obj, 'use');
	if (inline && ref) fail(where, 'a state is either inline (instruction) or a reference (use), not both');
	if (!inline && !ref) fail(where, 'a state needs either instruction or use');
	const exits = readExits(obj.exits, `${where}.exits`);
	if (inline) {
		keys(obj, ['instruction', 'exits'], where);
		return { instruction: prose(obj.instruction, `${where}.instruction`, LIMITS.instruction), exits };
	}
	keys(obj, ['use', 'exits'], where);
	const name = line(obj.use, `${where}.use`, LIMITS.name);
	if (name.includes(':')) fail(`${where}.use`, 'use is a bare global action name, not a scoped reference');
	if (!resolveGlobal) fail(`${where}.use`, 'no global resolver available to resolve referenced action');
	const resolved = resolveGlobal(name);
	if (resolved === undefined || resolved === null) fail(`${where}.use`, `unknown global action ${name}`);
	const action = validateStateAction(resolved);
	return { instruction: action.instruction, exits };
}

// Every state reachable from `start` must retain a route to completion, and no
// declared state may be unreachable from `start`.
function analyze(plan: StatePlan): void {
	const ids = Object.keys(plan.actions);
	// Reachability from start.
	const reachable = new Set<string>([plan.start]);
	const queue = [plan.start];
	while (queue.length) {
		const id = queue.shift()!;
		for (const exit of plan.actions[id].exits) {
			if (exit.to !== null && !reachable.has(exit.to)) {
				reachable.add(exit.to);
				queue.push(exit.to);
			}
		}
	}
	for (const id of ids) if (!reachable.has(id)) fail('flow', `state ${id} is unreachable from start`);
	// Can-complete: fixpoint over "has a completion exit, or routes to one".
	const canComplete = new Set<string>();
	let changed = true;
	while (changed) {
		changed = false;
		for (const id of ids) {
			if (canComplete.has(id)) continue;
			const node = plan.actions[id];
			const ok = node.exits.some((e) => e.to === null || (e.to !== null && canComplete.has(e.to)));
			if (ok) {
				canComplete.add(id);
				changed = true;
			}
		}
	}
	for (const id of reachable) if (!canComplete.has(id)) fail('flow', `state ${id} has no path to completion`);
}

/** Compile a new-style Flow definition into a detached, validated StatePlan.
 * `resolveGlobal` maps a bare global action name to its raw definition; it is
 * only consulted for `{ use }` reference nodes. */
export function compileState(raw: unknown, resolveGlobal?: (name: string) => unknown): StatePlan {
	const obj = record(raw, 'flow');
	keys(obj, ['mode', 'name', 'context', 'start', 'actions'], 'flow');
	if (obj.mode !== 'state') fail('flow.mode', "expected 'state'");
	const name = line(obj.name, 'flow.name', LIMITS.name);
	const context = Object.hasOwn(obj, 'context') ? prose(obj.context, 'flow.context', LIMITS.context, false) : '';
	const start = line(obj.start, 'flow.start', LIMITS.name);

	const rawActions = record(obj.actions, 'flow.actions');
	const entries = Object.entries(rawActions);
	if (entries.length === 0) fail('flow.actions', 'at least one state is required');
	if (entries.length > LIMITS.states) fail('flow.actions', `too many states (limit ${LIMITS.states})`);

	const actions: Record<string, StateNode> = Object.create(null) as Record<string, StateNode>;
	// Two states referencing the same Action must see one version, even across concurrent saves.
	const refs = new Map<string, unknown>();
	const resolveOnce = resolveGlobal && ((key: string) => {
		if (!refs.has(key)) refs.set(key, resolveGlobal(key));
		return refs.get(key);
	});
	let bytes = Buffer.byteLength(JSON.stringify({ mode: 'state', name, context, start, actions: {} }));
	for (const [id, spec] of entries) {
		safeKey(id, 'flow.actions');
		line(id, 'flow.actions (state ID)', LIMITS.name);
		const node = readNode(spec, `flow.actions.${id}`, resolveOnce);
		bytes += Buffer.byteLength(JSON.stringify(id)) + 2 + Buffer.byteLength(JSON.stringify(node));
		if (bytes > LIMITS.planBytes) fail('flow', 'resolved snapshot exceeds 512 KiB');
		actions[id] = node;
	}
	if (!Object.hasOwn(actions, start)) fail('flow.start', `start state ${start} is not defined`);
	// All non-completion exit targets must resolve to a declared state.
	for (const [id, node] of Object.entries(actions)) {
		for (const exit of node.exits) {
			if (exit.to !== null && !Object.hasOwn(actions, exit.to))
				fail(`flow.actions.${id}`, `exit targets unknown state ${exit.to}`);
		}
	}
	const plan: StatePlan = { mode: 'state', name, context, start, actions: { ...actions } };
	analyze(plan);
	return plan;
}
