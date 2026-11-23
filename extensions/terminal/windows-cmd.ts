import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { win32 } from "node:path";

// Source checkouts on non-Windows do not need to load the Windows codec.
const require = createRequire(import.meta.url);

export function isCmd(shell: string): boolean {
	return /^(?:cmd|cmd\.exe)$/i.test(win32.basename(shell));
}

function encodingName(page: string): string {
	return page === "65001" ? "utf8" : `cp${page}`;
}

/** chcp prints localized text; only the trailing ASCII code page number is significant. */
type CommandRunner = (file: string, args: string[], options: {
	env: NodeJS.ProcessEnv;
	timeout: number;
	stdio: ["ignore", "pipe", "ignore"];
}) => Buffer;

function detectPage(shell: string, env: NodeJS.ProcessEnv, run: CommandRunner): string | undefined {
	const options = { env, timeout: 1500, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
	try {
		const text = run(shell, ["/d", "/c", "chcp"], options).toString("latin1");
		const page = /(\d+)\s*$/.exec(text)?.[1];
		if (page) return page;
	} catch { /* Some GUI launches have no console to query. */ }
	try {
		const reg = win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "reg.exe");
		const text = run(reg, ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "OEMCP"], options).toString("latin1");
		return /\bOEMCP\s+REG_SZ\s+(\d+)/i.exec(text)?.[1];
	} catch { return undefined; }
}

/** cmd expands PROMPT's $P itself after commands. No injected command can accidentally
 * become stdin to set /p, or alter ERRORLEVEL. Frames may span pipe chunks without a newline. */
export class CmdPromptReader {
	private pending = "";
	private readonly begin: string;
	private readonly end: string;
	private readonly cwd: (dir: string) => void;
	constructor(begin: string, end: string, cwd: (dir: string) => void) {
		this.begin = begin;
		this.end = end;
		this.cwd = cwd;
	}
	read(chunk: string, eof = false): string {
		let text = this.pending + chunk, output = "";
		this.pending = "";
		while (text) {
			const start = text.indexOf(this.begin);
			if (start < 0) {
				let n = eof ? 0 : Math.min(this.begin.length - 1, text.length);
				while (n && !text.endsWith(this.begin.slice(0, n))) n--;
				this.pending = text.slice(text.length - n);
				return output + text.slice(0, text.length - n);
			}
			output += text.slice(0, start);
			text = text.slice(start);
			const stop = text.indexOf(this.end, this.begin.length);
			const candidate = text.slice(this.begin.length, stop < 0 ? undefined : stop);
			if (stop < 0 && !eof && candidate.length <= 32767 && !/[\r\n]/.test(candidate)) {
				this.pending = text;
				break;
			}
			if (stop >= 0 && candidate.length <= 32767 && win32.isAbsolute(candidate) && !/[\x00-\x1f]/.test(candidate)) {
				this.cwd(candidate);
				text = text.slice(stop + this.end.length);
			} else {
				output += this.begin;
				text = text.slice(this.begin.length);
			}
		}
		return output;
	}
}

export function configureCmd(
	shell: string,
	env: NodeJS.ProcessEnv,
	cwd: (dir: string) => void,
	run: CommandRunner = execFileSync,
) {
	const codec: typeof import("iconv-lite") = require("iconv-lite");
	const page = env.PI_TERMINAL_CMD_CODEPAGE?.trim() || detectPage(shell, env, run);
	const supported = !!page && /^\d+$/.test(page) && codec.encodingExists(encodingName(page));
	const encoding = supported ? encodingName(page!) : "utf8";
	const id = randomUUID();
	const begin = `[pi-cwd:${id}:`, end = `:${id}]`;
	const childEnv = { ...env };
	// Windows environment keys are case-insensitive; Node passes only the first variant.
	for (const key of Object.keys(childEnv)) if (key.toUpperCase() === "PROMPT") delete childEnv[key];
	childEnv.PROMPT = `${begin}$P${end}`;
	const makeStream = () => {
		const decoder = codec.getDecoder(encoding), reader = new CmdPromptReader(begin, end, cwd);
		return { write: (b: Buffer) => reader.read(decoder.write(b)), end: () => reader.read(decoder.end() || "", true) };
	};
	return {
		env: childEnv, stdout: makeStream(), stderr: makeStream(),
		encodeLine: (text: string) => codec.encode(text + "\r\n", encoding),
		warning: supported ? undefined : `无法识别 cmd 代码页${page ? ` (${page})` : ""}，暂用 UTF-8；可在启动 pi 前设置 PI_TERMINAL_CMD_CODEPAGE。`,
	};
}
