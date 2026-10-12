/**
 * terminal/shell.ts — 一个持久的 shell 进程会话(可折叠 / 可销毁)。
 *
 * 设计要点:
 *  - 用 detached 方式启动用户 shell,使其成为独立进程组(POSIX 下 setsid),
 *    销毁时用 process.kill(-pid) 一次性结束整棵进程树:既不会误杀 pi 自身所在的
 *    进程组,也不会留下孤儿 / 僵尸进程。
 *  - 命令通过 stdin 逐行喂给同一个常驻 shell 进程,因此 cwd / 环境变量 / shell
 *    状态在多次命令之间保持(等价于一个持久终端)。非交互式 shell 从管道 stdin
 *    逐行读取并执行,`cd` 等状态在同一进程内跨行保留。
 *  - 输出(stdout/stderr)实时汇入一个有界缓冲区;折叠时进程与缓冲区继续运行,
 *    重新打开即可看到折叠期间累积的输出。
 *  - 兜底:每个进程实例注册一次 `process.on("exit")`,对仍存活的进程组发
 *    SIGKILL,保证 pi 无论以何种方式退出都不遗留孤儿进程。
 *
 * 说明:这是「面向执行命令的行式终端」,不是完整 VT 终端仿真器(未引入 PTY/终端
 * 仿真库)。适合跑构建 / 开发服务 / git 等命令并持续观察输出;全屏交互式程序
 * (vim / top 等)不作为目标场景。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type ShellStatus = "running" | "exited" | "killed";

export interface ShellSessionOptions {
	name: string;
	cwd: string;
	shell?: string;
	env?: NodeJS.ProcessEnv;
}

/** 输出缓冲区保留的最大行数(超出丢弃最旧)。 */
const MAX_BUFFER_LINES = 5000;
/** 先 SIGTERM、超过该时间仍未退出则 SIGKILL 的宽限期。 */
const KILL_GRACE_MS = 1500;

/**
 * 本模块加载到的所有存活会话。用于进程退出时兜底清理。
 * 每次扩展(重新)加载都会得到一个新集合与一个新的 exit 钩子;
 * 旧钩子仍持有旧集合,因此 reload 后旧一代进程也会在退出时被清理。
 */
const liveSessions = new Set<ShellSession>();
let exitHooked = false;

function trackSession(session: ShellSession): void {
	liveSessions.add(session);
	if (!exitHooked) {
		exitHooked = true;
		// 'exit' 钩子里只能做同步操作:process.kill 是同步的。
		process.on("exit", () => {
			for (const s of liveSessions) s.killNow();
		});
	}
}

export class ShellSession {
	readonly name: string;
	readonly cwd: string;
	readonly shell: string;
	readonly pid: number | undefined;
	readonly createdAt = Date.now();

	/** 输出缓冲(每行可含 ANSI)。 */
	lines: string[] = [];
	status: ShellStatus = "running";
	exitCode: number | null = null;
	exitSignal: NodeJS.Signals | null = null;
	/** 有新输出时的回调(用于触发界面重绘)。 */
	onOutput: (() => void) | null = null;

	private child: ChildProcessWithoutNullStreams;
	private pending = "";
	private killTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

	constructor(opts: ShellSessionOptions) {
		this.name = opts.name;
		this.cwd = opts.cwd;
		this.shell = opts.shell || process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");

		this.child = spawn(this.shell, [], {
			cwd: this.cwd,
			env: opts.env ?? process.env,
			// 独立进程组:销毁时可安全 kill(-pid) 清掉整棵树。
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.pid = this.child.pid;
		trackSession(this);

		this.appendLine(`[终端 ${this.name}] pid=${this.pid ?? "?"} · shell=${this.shell} · cwd=${this.cwd}`);
		this.appendLine(`[提示] Esc=折叠(进程继续运行) · Ctrl+X=销毁(终止进程) · Ctrl+C=中断`);

		this.child.stdout.on("data", (chunk: Buffer) => this.ingest(chunk.toString()));
		this.child.stderr.on("data", (chunk: Buffer) => this.ingest(chunk.toString()));
		this.child.on("error", (err) => {
			this.appendLine(`[shell 启动失败] ${err.message}`);
			this.status = "exited";
			this.onOutput?.();
		});
		this.child.on("exit", (code, signal) => {
			this.flushPending();
			this.exitCode = code;
			this.exitSignal = signal;
			this.status = signal ? "killed" : "exited";
			if (this.killTimer) {
				clearTimeout(this.killTimer);
				this.killTimer = null;
			}
			liveSessions.delete(this);
			this.appendLine(`[进程已退出] ${signal ? `signal=${signal}` : `code=${code}`}`);
			this.onOutput?.();
		});
	}

	// -- 输出缓冲 ----------------------------------------------------------

	private ingest(text: string): void {
		this.pending += text;
		let idx: number;
		while ((idx = this.pending.indexOf("\n")) >= 0) {
			let line = this.pending.slice(0, idx);
			this.pending = this.pending.slice(idx + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			this.appendLine(line);
		}
		// 未换行的片段(如 printf 无换行、进度条)保留在 pending,由 getView 作为
		// 最后一行实时显示;后续到达的文本继续拼接,直到遇到换行才落为完整行。
		this.onOutput?.();
	}

	private flushPending(): void {
		if (this.pending) {
			this.appendLine(this.pending);
			this.pending = "";
		}
	}

	/**
	 * 公开 flush:把未换行的残留片段落为完整一行。
	 * 在发送下一条命令前调用,避免上一条的无换行输出与下一条输出拼接串行。
	 */
	flush(): void {
		this.flushPending();
	}

	/** 追加一行到缓冲(公开,供命令回显等外部注记使用)。 */
	appendLine(line: string): void {
		this.lines.push(line);
		if (this.lines.length > MAX_BUFFER_LINES) {
			this.lines.splice(0, this.lines.length - MAX_BUFFER_LINES);
		}
	}

	/** 清空可见缓冲(不重启进程),对应 Ctrl+L。 */
	clear(): void {
		this.lines = [];
		this.pending = "";
	}

	/**
	 * 取距离末尾 fromEnd 处往上 rows 行的窗口(用于滚动回看)。
	 * 贴底(fromEnd<=0)时把未换行的 pending 片段作为临时末行一并显示。
	 */
	getView(fromEnd: number, rows: number): string[] {
		const atBottom = fromEnd <= 0;
		const end = Math.max(0, this.lines.length - Math.max(0, fromEnd));
		const start = Math.max(0, end - rows);
		const view = this.lines.slice(start, end);
		if (atBottom && this.pending) view.push(this.pending);
		return view;
	}

	// -- 输入 / 进程控制 -----------------------------------------------------

	/**
	 * 向 shell 追加一行命令执行。返回是否成功送达(false = 进程已退出/不可写)。
	 * 发送前先 flush 残留片段,保证不同命令的输出不拼接。
	 */
	send(text: string): boolean {
		this.flushPending();
		if (this.status !== "running" || !this.child.stdin.writable) return false;
		try {
			this.child.stdin.write(`${text}\n`);
			return true;
		} catch {
			return false;
		}
	}

	/** 向前台进程组发 SIGINT(对应 Ctrl+C)。 */
	interrupt(): void {
		this.signalGroup("SIGINT");
	}

	/**
	 * 优雅销毁:先 SIGTERM,宽限期后仍未退出再 SIGKILL。
	 * 用户主动「销毁终端」时使用。
	 */
	kill(): void {
		if (this.disposed) return;
		this.signalGroup("SIGTERM");
		if (this.killTimer) clearTimeout(this.killTimer);
		const pid = this.pid;
		this.killTimer = setTimeout(() => {
			try {
				if (pid && process.platform !== "win32") process.kill(-pid, "SIGKILL");
				else this.child.kill("SIGKILL");
			} catch {
				/* 进程可能已退出 */
			}
			this.killTimer = null;
		}, KILL_GRACE_MS);
	}

	/** 立即硬杀进程组(同步),用于会话关闭 / 进程退出兜底,保证不留孤儿。 */
	killNow(): void {
		try {
			if (this.pid && process.platform !== "win32") process.kill(-this.pid, "SIGKILL");
			else this.child.kill("SIGKILL");
		} catch {
			/* 进程可能已退出 */
		}
	}

	/** 彻底释放:硬杀 + 清理定时器 / 监听 / stdio。幂等。 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		liveSessions.delete(this);
		if (this.killTimer) {
			clearTimeout(this.killTimer);
			this.killTimer = null;
		}
		this.killNow();
		try {
			this.child.stdin.end();
		} catch {
			/* ignore */
		}
		try {
			this.child.stdout.destroy();
			this.child.stderr.destroy();
		} catch {
			/* ignore */
		}
		this.onOutput = null;
		if (this.status === "running") this.status = "killed";
	}

	private signalGroup(sig: NodeJS.Signals): void {
		const pid = this.pid;
		try {
			// POSIX:负 pid 表示对整个进程组发信号(子进程树一并结束)。
			if (pid && process.platform !== "win32") process.kill(-pid, sig);
			else this.child.kill(sig);
		} catch {
			try {
				this.child.kill(sig);
			} catch {
				/* ignore */
			}
		}
	}
}
