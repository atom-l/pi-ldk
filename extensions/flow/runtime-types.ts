import type { Tool, ToolResultMessage } from '@earendil-works/pi-ai';

/** Tools belonging to an Action conversation only; not globally registered in Pi. */
export type FlowLocalTool = Tool & {
	execute(
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<{ content: ToolResultMessage['content']; isError?: boolean }>;
};
/** No arguments, tool output or private reasoning in the run journal. */
export type FlowToolEvent = {
	type: 'action_tool_start' | 'action_tool_finish';
	id: string;
	callId: string;
	tool: string;
	isError?: boolean;
};
export type FlowRuntime = {
	localTools: FlowLocalTool[];
	getLocalTools?(): FlowLocalTool[];
	hostToolVisible?(name: string): boolean;
	onTool(event: FlowToolEvent): void;
};
