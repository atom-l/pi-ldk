import { checkBag, forkPlan, type Bag, type Compiled, type ForkPlan, type Msg, type Resolved } from './contract.ts';

type Worker = { status: 'succeeded'; outputs: Bag } | { status: 'failed'; error: string } | { status: 'cancelled' };
type Snapshot = Record<string, Worker>;
export type RunEvent =
	| { type: 'node_start' | 'node_pruned'; id: string; kind: string }
	| { type: 'node_finish'; id: string; kind: string; outputs: Bag }
	| { type: 'node_failed'; id: string; kind: string; error: string }
	| { type: 'gate'; id: string; question: string; answer: boolean }
	| { type: 'worker_start'; forkId: string; input: string; id: string }
	| { type: 'worker_finish'; forkId: string; input: string; outputs: Bag; late: boolean }
	| { type: 'worker_cancelled'; forkId: string; input: string; late: boolean }
	| { type: 'worker_failed'; forkId: string; input: string; error: string; late: boolean }
	| { type: 'join_close'; id: string; snapshot: Snapshot }
	| { type: 'run_cancelled' }
	| { type: 'run_failed'; error: string }
	| { type: 'run_finish'; outputs: Bag };
type Options = {
	cwd: string;
	signal?: AbortSignal;
	event?: (e: RunEvent) => void;
	invoke: (node: Resolved, inputs: Bag, signal: AbortSignal, id: string) => Promise<Bag>;
	gate: (id: string, question: string, signal: AbortSignal, inputs: Bag) => Promise<boolean>;
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const nil: Msg = { type: 'null', value: null };
const cancelled = () => new DOMException('Flow cancelled', 'AbortError');
function deferred<T>() {
	let resolve!: (v: T) => void, reject!: (e: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

/** Interpret an already compiled DAG. Ordinary nodes evaluate once; a missing edge
 * value means a pruned route, never a null message. Structured workers have their
 * own cancellation scope; their lifetime may exceed the main graph's result. */
export function startRun(graph: Compiled, input: Bag, opt: Options) {
	const links = new Map(
		Object.keys(graph.nodes).map((id) => [id, { ins: [] as Compiled['edges'], outs: [] as Compiled['edges'] }]),
	);
	for (const e of graph.edges) {
		links.get(e.from[0])!.outs.push(e);
		links.get(e.to[0])!.ins.push(e);
	}
	const groups = new Map<string, { fork: string; plan: ForkPlan }>();
	for (const [id, n] of Object.entries(graph.nodes))
		if (n.kind === 'fork') {
			const plan = forkPlan(graph, id);
			groups.set(plan.joinId, { fork: id, plan });
		}
	const master = new AbortController(),
		result = deferred<Bag>();
	const pending = new Set<Promise<unknown>>();
	function track<T>(p: Promise<T>) {
		pending.add(p);
		void p.then(
			() => pending.delete(p),
			() => pending.delete(p),
		);
		return p;
	}
	const emit = (e: RunEvent) => {
		opt.event?.(e);
	};
	let settled = false;
	function fail(e: unknown) {
		if (settled) return;
		settled = true;
		master.abort(e);
		result.reject(e);
		emit({ type: 'run_failed', error: message(e) });
	}
	function cancel() {
		if (!master.signal.aborted) master.abort(cancelled());
		if (!settled) {
			settled = true;
			result.reject(cancelled());
			emit({ type: 'run_cancelled' });
		}
	}
	function finish(outputs: Bag) {
		if (settled || master.signal.aborted) return;
		settled = true;
		result.resolve(outputs);
		emit({ type: 'run_finish', outputs });
	}
	async function step(id: string, signal: AbortSignal, fn: () => Bag | Promise<Bag>) {
		const kind = graph.nodes[id].kind;
		signal.throwIfAborted();
		emit({ type: 'node_start', id, kind });
		try {
			const outputs = await fn();
			signal.throwIfAborted();
			emit({ type: 'node_finish', id, kind, outputs });
			return outputs;
		} catch (e) {
			if (signal.aborted) throw signal.reason;
			emit({ type: 'node_failed', id, kind, error: message(e) });
			if (e instanceof Error && e.name === 'AbortError') throw e;
			throw new Error(`${id}: ${message(e)}`);
		}
	}
	async function invoke(id: string, ins: Bag, signal: AbortSignal, partial = false) {
		const n = graph.nodes[id];
		return checkBag(await opt.invoke(n, ins, signal, id), n.outputs, opt.cwd, partial);
	}
	async function collect(joinId: string, forkId: string, plan: ForkPlan, seeds: Bag): Promise<Bag> {
		const n = graph.nodes[joinId],
			policy = n.join!,
			need = policy.waitFor === 'all' ? plan.branches.length : policy.waitFor;
		const waiting = deferred<Snapshot>(),
			picked = new Map<string, Worker>();
		const controllers = new Map(plan.branches.map((b) => [b.input, new AbortController()]));
		let open = true,
			left = controllers.size;
		const abort = () => {
			open = false;
			waiting.reject(master.signal.reason);
			for (const c of controllers.values()) c.abort(master.signal.reason);
		};
		master.signal.addEventListener('abort', abort, { once: true });
		const receive = (key: string, w: Worker) => {
			const attrs = { forkId, input: key, late: !open };
			if (w.status === 'succeeded') emit({ type: 'worker_finish', ...attrs, outputs: w.outputs });
			else if (w.status === 'failed') emit({ type: 'worker_failed', ...attrs, error: w.error });
			else emit({ type: 'worker_cancelled', ...attrs });
			controllers.delete(key);
			left--;
			if (!left) master.signal.removeEventListener('abort', abort);
			if (!open || master.signal.aborted) return;
			if (policy.countOn === 'settled' || w.status === 'succeeded') picked.set(key, w);
			if (picked.size === need) {
				open = false;
				const snapshot = structuredClone(Object.fromEntries(picked));
				emit({ type: 'join_close', id: joinId, snapshot });
				waiting.resolve(snapshot);
				if (policy.remaining === 'cancel') for (const c of controllers.values()) c.abort(cancelled());
			} else if (picked.size + left < need) {
				open = false;
				waiting.reject(
					new Error(
						`${joinId}: impossible threshold: need ${need} ${policy.countOn} worker(s), ${picked.size} matched and ${left} remain`,
					),
				);
			}
		};
		for (const b of plan.branches) {
			const signal = controllers.get(b.input)!.signal;
			// Queue all workers before any can close the join (including zero-step workers).
			track(
				Promise.resolve()
					.then(async () => {
						emit({ type: 'worker_start', forkId, input: b.input, id: b.nodes[0] ?? forkId });
						let record: Worker;
						try {
							signal.throwIfAborted();
							let edges = links.get(forkId)!.outs.filter((e) => e.from[1] === b.out);
							let outputs: Bag = { [b.out]: seeds[b.out] };
							for (const id of b.nodes) {
								const node = graph.nodes[id];
								const inputs = Object.fromEntries(edges.map((e) => [e.to[1], outputs[e.from[1]]]));
								outputs = await step(id, signal, () =>
									invoke(id, checkBag(inputs, node.inputs, opt.cwd), signal),
								);
								edges = links.get(id)!.outs;
							}
							signal.throwIfAborted();
							const link = edges[0]; // exactly one worker result is counted
							const received = checkBag({ [b.input]: outputs[link.from[1]] }, n.inputs, opt.cwd, true)[
								b.input
							];
							record = { status: 'succeeded', outputs: { ...outputs, [link.from[1]]: received } };
						} catch (e) {
							record =
								signal.aborted || (e instanceof Error && e.name === 'AbortError')
									? { status: 'cancelled' }
									: { status: 'failed', error: message(e) };
						}
						receive(b.input, record);
					})
					.catch(fail),
			);
		}
		const snap = await waiting.promise;
		master.signal.throwIfAborted();
		return step(joinId, master.signal, () => {
			const envelope: Bag = { out: { type: 'object', value: snap } };
			return n.template ? invoke(joinId, envelope, master.signal) : checkBag(envelope, n.outputs, opt.cwd);
		});
	}
	// Memoization is keyed by node position, never action definition name. Deferring
	// evaluation by a microtask also avoids recursing on the JS call stack for long DAGs.
	const cache = new Map<string, Promise<Bag | undefined>>();
	function evaluate(id: string): Promise<Bag | undefined> {
		let p = cache.get(id);
		if (!p) {
			p = track(Promise.resolve().then(() => compute(id)));
			cache.set(id, p);
		}
		return p;
	}
	async function compute(id: string): Promise<Bag | undefined> {
		const n = graph.nodes[id],
			sig = master.signal;
		sig.throwIfAborted();
		const skip = () => {
			emit({ type: 'node_pruned', id, kind: n.kind });
			return undefined;
		};
		if (n.kind === 'start') return step(id, sig, () => checkBag(input, n.outputs, opt.cwd));
		if (n.kind === 'join') {
			const g = groups.get(id)!;
			const seeds = await evaluate(g.fork);
			sig.throwIfAborted();
			return seeds ? collect(id, g.fork, g.plan, seeds) : skip();
		}
		const ins: Bag = {};
		await Promise.all(
			links.get(id)!.ins.map(async (edge) => {
				const upstream = await evaluate(edge.from[0]);
				if (upstream && Object.hasOwn(upstream, edge.from[1])) ins[edge.to[1]] = upstream[edge.from[1]];
			}),
		);
		sig.throwIfAborted();
		if (!Object.keys(ins).length) return skip();
		return step(id, sig, async () => {
			const bag = checkBag(ins, n.inputs, opt.cwd);
			if (n.kind === 'end') return bag;
			if (n.kind === 'fork')
				return checkBag(
					Object.fromEntries(Object.keys(n.outputs).map((k) => [k, Object.values(bag)[0]])),
					n.outputs,
					opt.cwd,
				);
			if (n.kind === 'gate') {
				const question = n.question ?? id,
					answer = await opt.gate(id, question, sig, bag);
				sig.throwIfAborted();
				emit({ type: 'gate', id, question, answer });
				return { [answer ? 'yes' : 'no']: nil };
			}
			if (n.kind === 'decision') {
				if (n.template) {
					const choice = await invoke(id, bag, sig, true);
					if (Object.keys(choice).length !== 1) throw new Error('decision requires exactly one output');
					return choice;
				}
				const [key, ...fields] = (n.test ?? Object.keys(bag)[0]).split('.');
				let v: unknown = bag[key]?.value;
				for (const f of fields)
					v =
						v !== null && typeof v === 'object' && Object.hasOwn(v, f)
							? (v as Record<string, unknown>)[f]
							: undefined;
				if (typeof v !== 'boolean') throw new Error('decision test result is not a boolean');
				return { [v ? 'yes' : 'no']: nil };
			}
			return invoke(id, bag, sig);
		});
	}
	if (opt.signal?.aborted) cancel();
	else opt.signal?.addEventListener('abort', cancel, { once: true });
	const ends = Object.keys(graph.nodes).filter((id) => graph.nodes[id].kind === 'end');
	void Promise.all(
		ends.map(async (id) => {
			const bag = await evaluate(id);
			if (bag) finish(bag);
		}),
	).then(() => {
		if (!settled) fail(new Error('No active end node'));
	}, fail);
	const drained = (async () => {
		try {
			await result.promise;
		} catch {
			/* main error remains observable via done */
		}
		while (pending.size) await Promise.allSettled([...pending]);
		opt.signal?.removeEventListener('abort', cancel);
	})();
	return { done: result.promise, drained, cancel };
}
