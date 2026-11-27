import { resolve } from 'node:path';

export type PortType = 'null' | 'text' | 'boolean' | 'object' | 'file' | 'any';
export type Port = { type: PortType; fields?: Record<string, Port> };
export type Msg = { type: Exclude<PortType, 'any'>; value: any };
export type Bag = Record<string, Msg>;
export type Join = { waitFor: 'all' | number; countOn: 'succeeded' | 'settled'; remaining: 'cancel' | 'finish' };
type Ports = Record<string, Port>;
export type Action = {
	extends: string;
	inputs?: Ports;
	outputs?: Ports;
	template?: string;
	tools?: string[];
	join?: Join;
	test?: string;
	question?: string;
};
export type Flow = {
	name: string;
	nodes: Record<string, { use: string | Action }>;
	edges: { from: [string, string]; to: [string, string] }[];
	actions?: Record<string, Action>;
};
type Kind = 'action' | 'task' | 'start' | 'end' | 'decision' | 'fork' | 'join' | 'gate';
export type Resolved = Omit<Action, 'extends' | 'inputs' | 'outputs'> & { kind: Kind; inputs: Ports; outputs: Ports };
export type Compiled = { name: string; nodes: Record<string, Resolved>; edges: Flow['edges'] };
export type ForkPlan = { joinId: string; branches: { out: string; input: string; nodes: string[] }[] };

function fail(where: string, message: string): never {
	throw new Error(`${where}: ${message}`);
}
function record(v: unknown, where: string): Record<string, unknown> {
	if (
		!v ||
		typeof v !== 'object' ||
		(Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
	) {
		fail(where, 'expected a JSON object');
	}
	return v as Record<string, unknown>;
}
function keys(obj: Record<string, unknown>, allowed: string[], where: string) {
	for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(where, `unknown property ${k}`);
}
function text(v: unknown, where: string): string {
	if (typeof v !== 'string' || !v.trim()) fail(where, 'expected nonempty string');
	return v;
}
function name(v: unknown, where: string): string {
	const n = text(v, where);
	// These dictionaries are passed to other JS consumers too, not just this module.
	if (n === 'prototype' || Object.hasOwn(Object.prototype, n)) fail(where, `reserved name ${n}`);
	return n;
}
function oneOf<T extends string>(v: unknown, choices: readonly T[], where: string): T {
	if (!choices.includes(v as T)) fail(where, `expected ${choices.join('|')}`);
	return v as T;
}
const types = ['null', 'text', 'boolean', 'object', 'file', 'any'] as const;
function readPorts(v: unknown, where: string, depth = 0): Ports {
	if (depth > 64) fail(where, 'field nesting too deep');
	return Object.fromEntries(
		Object.entries(record(v, where)).map(([k, raw]) => {
			name(k, where);
			const label = `${where}.${k}`,
				p = record(raw, label);
			keys(p, ['type', 'fields'], label);
			const type = oneOf(p.type, types, label);
			if (!Object.hasOwn(p, 'fields')) return [k, { type }];
			if (type !== 'object') fail(label, 'only object ports have fields');
			return [k, { type, fields: readPorts(p.fields, `${label}.fields`, depth + 1) }];
		}),
	);
}

// Objects carry JSON values, not envelopes for their individual fields.
function checkJson(v: unknown, where: string, seen: Set<object>, depth: number) {
	if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
		return;
	if (!v || typeof v !== 'object') fail(where, 'not a JSON value');
	if (depth > 128 || seen.has(v)) fail(where, 'cyclic or excessively nested JSON value');
	seen.add(v);
	if (Array.isArray(v)) {
		for (let i = 0; i < v.length; i++) checkJson(v[i], `${where}[${i}]`, seen, depth + 1);
	} else {
		for (const [k, x] of Object.entries(record(v, where))) checkJson(x, `${where}.${k}`, seen, depth + 1);
	}
	seen.delete(v);
}
// Return the checked value: a file is a lexical path (possibly a future
// artifact), not a filesystem probe or capability. Only declared file fields
// are normalized. Preserve untyped JSON fields without interpreting strings.
function checkValue(v: unknown, p: Port, cwd: string, where: string): unknown {
	switch (p.type) {
		case 'any':
			return v; // JSON-ness checked once at the envelope boundary
		case 'null':
			if (v !== null) fail(where, 'expected null');
			return v;
		case 'boolean':
			if (typeof v !== 'boolean') fail(where, 'expected boolean');
			return v;
		case 'text':
			if (typeof v !== 'string') fail(where, 'expected text');
			return v;
		case 'file':
			return resolve(cwd, text(v, where));
		case 'object': {
			const obj = record(v, where),
				checked = { ...obj };
			for (const [k, f] of Object.entries(p.fields ?? {})) {
				if (!Object.hasOwn(obj, k)) fail(where, `missing field ${k}`);
				checked[k] = checkValue(obj[k], f, cwd, `${where}.${k}`);
			}
			return checked;
		}
	}
}
export function checkBag(bag: unknown, ports: Ports, cwd: string, partial = false): Bag {
	const obj = record(bag, 'bag');
	if (!partial) for (const k of Object.keys(ports)) if (!Object.hasOwn(obj, k)) fail('bag', `missing port ${k}`);
	return Object.fromEntries(
		Object.entries(obj).map(([k, v]): [string, Msg] => {
			if (!Object.hasOwn(ports, k)) fail('bag', `unknown port ${k}`);
			const where = `bag.${k}`,
				msg = record(v, where);
			keys(msg, ['type', 'value'], where);
			const type = oneOf(msg.type, types, where);
			if (type === 'any') fail(where, 'message must have a concrete type');
			if (!Object.hasOwn(msg, 'value')) fail(where, 'missing value');
			const p = ports[k];
			if (p.type !== 'any' && type !== p.type) fail(where, `expected ${p.type} message, got ${type}`);
			if (type === 'object') checkJson(msg.value, where, new Set(), 0);
			return [k, { type, value: checkValue(msg.value, p.type === 'any' ? { type } : p, cwd, where) }];
		}),
	);
}
function compatible(src: Port, dst: Port): boolean {
	if (src.type === 'any' || dst.type === 'any') return true;
	if (src.type !== dst.type) return false;
	return Object.entries(dst.fields ?? {}).every(
		([k, p]) => src.fields && Object.hasOwn(src.fields, k) && compatible(src.fields[k], p),
	);
}

const any: Port = { type: 'any' },
	nil: Port = { type: 'null' };
const yesNo = { yes: nil, no: nil };
const standard = { inputs: { in: any }, outputs: { out: any } };
const builtins: Record<Kind, Resolved> = {
	action: { kind: 'action', ...standard },
	task: { kind: 'task', ...standard },
	start: { kind: 'start', inputs: {}, outputs: { out: nil } },
	end: { kind: 'end', inputs: { in: any }, outputs: {} },
	decision: { kind: 'decision', inputs: { in: { type: 'boolean' } }, outputs: yesNo },
	gate: { kind: 'gate', inputs: { in: any }, outputs: yesNo },
	fork: { kind: 'fork', inputs: { in: any }, outputs: {} },
	join: {
		kind: 'join',
		inputs: {},
		outputs: { out: { type: 'object' } },
		join: { waitFor: 'all', countOn: 'succeeded', remaining: 'cancel' },
	},
};
function readJoin(raw: unknown, where: string): Join {
	const j = record(raw, where);
	keys(j, ['waitFor', 'countOn', 'remaining'], where);
	const waitFor = j.waitFor;
	if (waitFor !== 'all' && !(typeof waitFor === 'number' && Number.isSafeInteger(waitFor) && waitFor > 0))
		fail(where, 'invalid waitFor threshold');
	return {
		waitFor,
		countOn: oneOf(j.countOn, ['succeeded', 'settled'], where),
		remaining: oneOf(j.remaining, ['cancel', 'finish'], where),
	};
}
function extend(parent: Resolved, obj: Record<string, unknown>, where: string): Resolved {
	keys(obj, ['extends', 'inputs', 'outputs', 'template', 'tools', 'join', 'test', 'question'], where);
	const r = { ...parent };
	for (const k of ['inputs', 'outputs'] as const) if (Object.hasOwn(obj, k)) r[k] = readPorts(obj[k], `${where}.${k}`);
	for (const k of ['template', 'test', 'question'] as const)
		if (Object.hasOwn(obj, k)) r[k] = text(obj[k], `${where}.${k}`);
	if (Object.hasOwn(obj, 'join')) r.join = readJoin(obj.join, `${where}.join`);
	if (Object.hasOwn(obj, 'tools')) {
		if (!Array.isArray(obj.tools)) fail(where, 'tools must be a string array');
		r.tools = obj.tools.map((t) => text(t, `${where}.tools`));
		if (new Set(r.tools).size !== r.tools.length) fail(where, 'duplicate tool');
	}
	return r;
}
function inspect(r: Resolved, where: string, concrete: boolean) {
	const inputs = Object.keys(r.inputs),
		outputs = Object.keys(r.outputs),
		k = r.kind;
	if (k === 'start' && inputs.length) fail(where, 'start cannot have inputs');
	if (k === 'end' && outputs.length) fail(where, 'end cannot have outputs');
	if (k !== 'decision' && r.test !== undefined) fail(where, 'test is only for decision');
	if (k !== 'gate' && r.question !== undefined) fail(where, 'question is only for gate');
	if (k !== 'join' && r.join) fail(where, 'join policy requires a join');
	if (r.template && !['decision', 'action', 'task', 'join'].includes(k)) fail(where, `${k} cannot invoke a template`);
	if (r.tools?.length && !['decision', 'action', 'task', 'join'].includes(k)) fail(where, `${k} cannot invoke tools`);
	if (k === 'gate' || (k === 'decision' && !r.template)) {
		if (outputs.length !== 2 || r.outputs.yes?.type !== 'null' || r.outputs.no?.type !== 'null')
			fail(where, `${k} requires yes/no null outputs`);
	}
	if (k === 'decision') {
		if (r.test && r.template) fail(where, 'choose test or template, not both');
		if (!r.template) {
			const path = (r.test ?? (inputs.length === 1 ? inputs[0] : '')).split('.');
			let p: Port | undefined = r.inputs[path[0]];
			if (!Object.hasOwn(r.inputs, path[0])) fail(where, 'decision test must name an input');
			for (const field of path.slice(1)) {
				name(field, `${where}.test`);
				if (p?.type === 'any' || (p?.type === 'object' && !p.fields)) {
					p = any;
					continue;
				}
				if (!p?.fields || !Object.hasOwn(p.fields, field)) fail(where, `invalid test field ${field}`);
				p = p.fields[field];
			}
			if (p?.type !== 'boolean' && p?.type !== 'any') fail(where, 'decision test requires boolean');
		}
	}
	if (k === 'fork') {
		if (inputs.length !== 1) fail(where, 'fork copies exactly one input');
		for (const out of outputs)
			if (!compatible(r.inputs[inputs[0]], r.outputs[out])) fail(where, `incompatible fork output ${out}`);
	}
	if (
		k === 'join' &&
		!r.template &&
		(outputs.length !== 1 || r.outputs.out?.type !== 'object' || Object.keys(r.outputs.out.fields ?? {}).length)
	) {
		fail(where, 'join without template emits {out:object}');
	}
	if (concrete) {
		if (k !== 'start' && !inputs.length) fail(where, 'no declared inputs');
		if (k !== 'end' && !outputs.length) fail(where, 'no declared outputs');
	}
	if (r.join && typeof r.join.waitFor === 'number' && (concrete || inputs.length > 0) && r.join.waitFor > inputs.length)
		fail(where, 'waitFor exceeds worker count');
}

/** Global definitions resolve in their own scope, even when reached through a local alias. */
function resolver(globals: Record<string, unknown>, locals: Record<string, unknown>) {
	const cache = new Map<string, Resolved>(),
		active = new Set<string>();
	function ref(value: unknown, allowLocal: boolean, where: string): Resolved {
		const s = text(value, where),
			m = /^(builtin|global|local):([^:]+)$/u.exec(s);
		if (!m) fail(where, `expected explicit builtin:/global:/local: reference, got ${s}`);
		const [, scope, id] = m;
		name(id, where);
		if (scope === 'local' && !allowLocal) fail(where, `global action cannot reference ${s}`);
		if (scope === 'builtin') {
			if (!Object.hasOwn(builtins, id)) fail(where, `unknown ${s}`);
			return builtins[id as Kind];
		}
		const result = cache.get(s);
		if (result) return result;
		if (active.has(s)) fail(where, `inheritance cycle at ${s}`);
		const defs = scope === 'local' ? locals : globals;
		if (!Object.hasOwn(defs, id)) fail(where, `unknown ${s}`);
		active.add(s);
		const r = action(defs[id], scope === 'local', s);
		active.delete(s);
		cache.set(s, r);
		return r;
	}
	function action(value: unknown, allowLocal: boolean, where: string) {
		const raw = record(value, where),
			r = extend(ref(raw.extends, allowLocal, where), raw, where);
		inspect(r, where, false);
		return r;
	}
	return { ref, action };
}
// Inspect inherited ports during editing, when the surrounding draft is not yet a valid DAG.
export function resolveUse(use: string | Action, globals: Record<string, Action>, locals: Record<string, Action>): Resolved {
	const r = resolver(globals, locals);
	return structuredClone(typeof use === 'string' ? r.ref(use, true, 'node.use') : r.action(use, true, 'node.use'));
}
export function validateAction(id: string, action: Action, globals: Record<string, Action>): void {
	name(id, 'global action');
	const defs = { ...record(globals, 'globals'), [id]: action };
	resolver(defs, {}).ref(`global:${id}`, false, `global:${id}`);
}

type Edge = Flow['edges'][number];
function indexGraph(g: Compiled) {
	const links = new Map(Object.keys(g.nodes).map((id) => [id, { incoming: [] as Edge[], outgoing: [] as Edge[] }]));
	for (const edge of g.edges) {
		links.get(edge.from[0])!.outgoing.push(edge);
		links.get(edge.to[0])!.incoming.push(edge);
	}
	return links;
}
type Links = ReturnType<typeof indexGraph>;
function plan(g: Compiled, forkId: string, links: Links): ForkPlan {
	const fork = g.nodes[forkId];
	if (fork?.kind !== 'fork') fail(forkId, 'not a fork');
	const branches: ForkPlan['branches'] = [],
		visited = new Set<string>(),
		inputs = new Set<string>();
	let joinId: string | undefined;
	for (const out of Object.keys(fork.outputs)) {
		const first = links.get(forkId)!.outgoing.filter((e) => e.from[1] === out);
		if (
			!first.length ||
			first.some((e) => e.to[0] !== first[0].to[0]) ||
			(g.nodes[first[0].to[0]].kind === 'join' && first.length !== 1)
		)
			fail(forkId, `fork output ${out} must start exactly one worker`);
		let bundle = first;
		let [id, input] = bundle[0].to;
		const nodes: string[] = [];
		while (g.nodes[id].kind !== 'join') {
			const { kind } = g.nodes[id];
			if (kind !== 'action' && kind !== 'task') fail(forkId, `unsupported ${kind} before join on branch ${out}`);
			const { incoming, outgoing } = links.get(id)!;
			// A worker is a chain of nodes, not a chain of single-port messages:
			// adjacent steps can transfer multiple named values together.
			if (
				incoming.length !== bundle.length ||
				!outgoing.length ||
				outgoing.some((e) => e.to[0] !== outgoing[0].to[0]) ||
				visited.has(id)
			)
				fail(forkId, `worker ${id} is not a disjoint linear chain`);
			visited.add(id);
			nodes.push(id);
			bundle = outgoing;
			[id, input] = bundle[0].to;
		}
		if (bundle.length !== 1)
			fail(forkId, 'each worker delivers to exactly one join input; its record retains all output ports');
		if (joinId !== undefined && joinId !== id) fail(forkId, 'branches reach different joins');
		joinId = id;
		if (inputs.has(input)) fail(id, `join input ${input} must be unique per worker`);
		inputs.add(input);
		branches.push({ out, input, nodes });
	}
	if (joinId === undefined) fail(forkId, 'fork has no branches');
	if (inputs.size !== Object.keys(g.nodes[joinId].inputs).length || inputs.size !== links.get(joinId)!.incoming.length)
		fail(joinId, 'unpaired or external join input');
	return { joinId, branches };
}
export function forkPlan(graph: Compiled, forkId: string): ForkPlan {
	return plan(graph, forkId, indexGraph(graph));
}

/** Canonical choice diagrams: two guards are equal iff their IDs match. A
 * variable is a decision/gate; children correspond to its possible outputs.
 * We can prove an exclusive merge and detect partial activation without
 * enumerating every execution path. Terminals: 0 = never, 1 = always. */
class Guards {
	variables: string[][] = [];
	nodes: { v: number; children: number[] }[] = [];
	unique = new Map<string, number>();
	memo = new Map<string, number>();
	branch(v: number, children: number[]): number {
		if (children.every((id) => id === children[0])) return children[0];
		const key = `${v}:${children.join(',')}`,
			known = this.unique.get(key);
		if (known !== undefined) return known;
		if (this.nodes.length >= 100000) fail('flow', 'choice graph too complex');
		const id = this.nodes.push({ v, children }) + 1;
		this.unique.set(key, id);
		return id;
	}
	combine(a: number, b: number, and: boolean): number {
		if (a > b) return this.combine(b, a, and);
		if (a === b) return a;
		if (a === 0) return and ? 0 : b;
		if (a === 1) return and ? b : 1;
		const key = `${a}:${b}:${+and}`,
			known = this.memo.get(key);
		if (known !== undefined) return known;
		const x = this.nodes[a - 2],
			y = this.nodes[b - 2],
			v = Math.max(x.v, y.v);
		const result = this.branch(
			v,
			this.variables[v].map((_, i) => this.combine(x.v === v ? x.children[i] : a, y.v === v ? y.children[i] : b, and)),
		);
		this.memo.set(key, result);
		return result;
	}
}
function validateGraph(g: Compiled) {
	const links = indexGraph(g),
		ids = [...links.keys()];
	if (ids.filter((id) => g.nodes[id].kind === 'start').length !== 1) fail('flow', 'requires exactly one start');
	const indegree = new Map(ids.map((id) => [id, links.get(id)!.incoming.length]));
	const order = ids.filter((id) => indegree.get(id) === 0);
	for (let i = 0; i < order.length; i++) {
		for (const {
			to: [id],
		} of links.get(order[i])!.outgoing) {
			const n = indegree.get(id)! - 1;
			indegree.set(id, n);
			if (n === 0) order.push(id);
		}
	}
	if (order.length !== ids.length) fail('flow', 'cycle in graph');
	const paired = new Set<string>();
	for (const id of ids)
		if (g.nodes[id].kind === 'fork') {
			const { joinId } = plan(g, id, links);
			if (paired.has(joinId)) fail(id, 'ambiguous fork/join pairing');
			paired.add(joinId);
		}
	const guards = new Guards(),
		onEdge = new Map<Edge, number>();
	let ends = 0;
	for (const id of order) {
		const n = g.nodes[id],
			{ incoming, outgoing } = links.get(id)!;
		if (n.kind === 'join' && !paired.has(id)) fail(id, 'join without paired fork');
		let active = n.kind === 'start' ? 1 : -1;
		const perPort = new Map<string, number>();
		for (const e of incoming) {
			const input = e.to[1],
				prior = perPort.get(input) ?? 0,
				next = onEdge.get(e)!;
			if (guards.combine(prior, next, true)) fail(id, `multiple active producers for input ${input}`);
			perPort.set(input, guards.combine(prior, next, false));
		}
		for (const input of Object.keys(n.inputs)) {
			const guard = perPort.get(input);
			if (!guard) fail(id, `unconnected or unreachable input ${input}`);
			if (active !== -1 && active !== guard) fail(id, 'inputs do not activate together on all paths');
			active = guard;
		}
		if (n.kind === 'end') {
			if (guards.combine(ends, active, true)) fail(id, 'multiple ends active on one path');
			ends = guards.combine(ends, active, false);
		} else if (!outgoing.length) fail(id, 'dead end without an end node');
		if (n.kind === 'decision' || n.kind === 'gate') {
			const outputs = Object.keys(n.outputs),
				v = guards.variables.push(outputs) - 1;
			const used = new Set(outgoing.map((e) => e.from[1]));
			if (used.size !== outputs.length) fail(id, 'unconnected choice output');
			for (const e of outgoing)
				onEdge.set(
					e,
					guards.branch(
						v,
						outputs.map((k) => (k === e.from[1] ? active : 0)),
					),
				);
		} else for (const e of outgoing) onEdge.set(e, active);
	}
	if (ends !== 1) fail('flow', 'all routes must reach an end');
}

export function compile(flow: unknown, globals: Record<string, Action>): Compiled {
	const raw = record(flow, 'flow');
	keys(raw, ['name', 'nodes', 'edges', 'actions'], 'flow');
	const flowName = name(raw.name, 'flow.name');
	const locals = Object.hasOwn(raw, 'actions') ? record(raw.actions, 'flow.actions') : {};
	const resolve = resolver(record(globals, 'globals'), locals);
	for (const id of Object.keys(locals)) resolve.ref(`local:${id}`, true, `flow.actions.${id}`);
	const nodes: Record<string, Resolved> = {};
	for (const [id, spec] of Object.entries(record(raw.nodes, 'flow.nodes'))) {
		name(id, 'node id');
		const node = record(spec, id);
		keys(node, ['use'], id);
		const r = typeof node.use === 'string' ? resolve.ref(node.use, true, id) : resolve.action(node.use, true, id);
		inspect(r, id, true);
		nodes[id] = structuredClone(r); // compiled graphs never share mutable declarations
	}
	if (!Array.isArray(raw.edges)) fail('flow.edges', 'expected array');
	const edges = raw.edges.map((e: unknown, i: number): Edge => {
		const where = `edges[${i}]`,
			edge = record(e, where);
		keys(edge, ['from', 'to'], where);
		function endpoint(side: 'from' | 'to'): [string, string] {
			const pair = edge[side];
			if (!Array.isArray(pair) || pair.length !== 2) fail(where, `expected [node,port] for ${side}`);
			const id = name(pair[0], where),
				port = name(pair[1], where);
			if (!Object.hasOwn(nodes, id)) fail(where, `unknown node ${id}`);
			if (!Object.hasOwn(side === 'from' ? nodes[id].outputs : nodes[id].inputs, port))
				fail(where, `unknown ${side} port ${id}.${port}`);
			return [id, port];
		}
		const from = endpoint('from'),
			to = endpoint('to');
		if (!compatible(nodes[from[0]].outputs[from[1]], nodes[to[0]].inputs[to[1]]))
			fail(where, `incompatible ${from.join('.')} -> ${to.join('.')}`);
		return { from, to };
	});
	const graph = { name: flowName, nodes, edges };
	validateGraph(graph);
	return graph;
}
