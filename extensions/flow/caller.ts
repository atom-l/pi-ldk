import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';

/** A nested Pi tool call belongs to a live outer tool call. A flow can outlive one
 * (e.g. a human gate). Never use the old caller after sending its result to Pi. */
export class Caller {
	private current?: ExtensionToolContext;
	private users = 0;
	private waiters = new Set<() => void>();
	private notify() {
		for (const wake of [...this.waiters]) wake();
	}
	private until(test: () => boolean, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const finish = () => {
				this.waiters.delete(wake);
				signal?.removeEventListener('abort', wake);
			};
			const wake = () => {
				if (signal?.aborted) {
					finish();
					reject(signal.reason);
				} else if (test()) {
					finish();
					resolve();
				}
			};
			this.waiters.add(wake);
			signal?.addEventListener('abort', wake, { once: true });
			wake();
		});
	}
	attach(ctx: ExtensionToolContext) {
		if (this.current || this.users) throw new Error('Run already has a live Pi caller');
		this.current = ctx;
		this.notify();
	}
	async detach() {
		this.current = undefined;
		await this.until(() => this.users === 0);
	}
	async use<T>(signal: AbortSignal, fn: (ctx: ExtensionToolContext) => Promise<T>): Promise<T> {
		while (!this.current) await this.until(() => !!this.current, signal);
		signal.throwIfAborted();
		this.users++;
		try {
			return await fn(this.current);
		} finally {
			this.users--;
			this.notify();
		}
	}
}
