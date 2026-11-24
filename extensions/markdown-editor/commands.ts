import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

// Pi's interactive submit handler accepts arguments only for these built-ins.
// Keep this list aligned with setupEditorSubmitHandler() in Pi; the public
// pi.getCommands() API covers extension, prompt-template and skill commands,
// but intentionally does not include the interactive built-ins.
const BUILTINS_WITH_ARGUMENTS = new Set([
	"model",
	"thinking",
	"export",
	"import",
	"bug",
	"name",
	"login",
	"compact",
]);

const BUILTINS_WITHOUT_ARGUMENTS = new Set([
	"settings",
	"scoped-models",
	"share",
	"copy",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"tree",
	"trust",
	"logout",
	"new",
	"reload",
	"debug",
	"arminsayshi",
	"dementedelves",
	"resume",
	"quit",
]);

/**
 * Whether Pi would interpret this single-line input as a slash command.
 * Argument validity is left to the command itself, matching native Pi.
 */
export function isPiCommand(text: string, commands: readonly SlashCommandInfo[]): boolean {
	const input = text.trim();
	if (!input.startsWith("/") || /[\r\n]/.test(input)) return false;
	const match = /^\/([^\s]+)([\s\S]*)$/.exec(input);
	if (!match) return false;
	const [, name, rest] = match;

	if (BUILTINS_WITH_ARGUMENTS.has(name)) return rest === "" || rest.startsWith(" ");
	if (BUILTINS_WITHOUT_ARGUMENTS.has(name)) return rest === "";

	const command = commands.find((candidate) => candidate.name === name);
	if (!command) return false;
	// Extension command parsing splits at a literal space. Prompt templates
	// and skill invocations accept general whitespace between name and args.
	return command.source === "extension" ? rest === "" || rest.startsWith(" ") : true;
}
