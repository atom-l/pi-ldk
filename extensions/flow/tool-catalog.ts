import type { Tool } from '@earendil-works/pi-ai';
import type { FlowLocalTool } from './runtime-types.ts';

// Soft request budgets. A *single* explicitly requested oversized schema may take a
// turn by itself (+ the catalog); never silently lose a tool just because it was last.
const COUNT = 32,
	BYTES = 48 * 1024,
	PAGE = 8;
const common = [
	'flow_ask_form',
	'flow_context_list',
	'flow_context_read',
	'flow_context_share',
	'read',
	'bash',
	'edit',
	'write',
	'grep',
	'find',
	'ls',
];
const size = (tool: Tool) => Buffer.byteLength(JSON.stringify(tool)) + 1;

/** Action-conversation state, not shared across nodes, runs, or Pi's top-level loadout. */
export class ActionCatalog {
	private pins: string[] = [];

	select(tools: Tool[], required: readonly string[], contextWindow?: number): { tools: Tool[]; search?: FlowLocalTool } {
		const budget = Math.min(BYTES, Math.max(4096, contextWindow || BYTES));
		if (tools.length <= COUNT && tools.reduce((n, t) => n + size(t), 2) <= budget) return { tools };
		const byName = new Map(tools.map((t) => [t.name, t]));
		// Never shadow an actual tool named flow_tools, even when it isn't on this page.
		let name = 'flow_tools';
		while (byName.has(name)) name += '_';
		const search: FlowLocalTool = {
			name,
			description:
				'Search this Action’s current tools by name or description (blank query: browse). Returns a page of names and short descriptions; prioritizes that page’s schemas for your next turn. Search by exact name to load one large tool. Does not execute tools or change host permissions.',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					query: { type: 'string', maxLength: 256 },
					offset: { type: 'integer', minimum: 0 },
				},
			},
			execute: async (args, signal) => {
				signal.throwIfAborted();
				const q = String(args.query ?? '')
						.trim()
						.toLowerCase(),
					offset = Number(args.offset ?? 0);
				const words = q.split(/\s+/);
				const matches = tools
					.filter((t) => {
						const text = `${t.name} ${t.description}`.toLowerCase();
						return words.every((word) => text.includes(word));
					})
					.sort(
						(a, b) =>
							Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q) ||
							a.name.localeCompare(b.name),
					);
				const page = matches.slice(offset, offset + PAGE);
				this.pins = page.map((t) => t.name);
				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								matches: page.map((t) => ({ name: t.name, description: t.description.slice(0, 240) })),
								nextOffset: offset + PAGE < matches.length ? offset + PAGE : null,
							}),
						},
					],
				};
			},
		};
		const chosen: Tool[] = [];
		let bytes = size(search) + 2;
		const priority = new Set([...this.pins, ...required]);
		for (const key of new Set([...priority, ...common, ...byName.keys()])) {
			const t = byName.get(key);
			if (!t) continue; // Refresh/revocation wins over old pins.
			const n = size(t);
			if (bytes + n > budget && (chosen.length || !priority.has(key))) continue;
			chosen.push(t);
			bytes += n;
			if (chosen.length + 1 === COUNT || bytes >= budget) break;
		}
		return { tools: chosen, search };
	}
}
