import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RunLock {
	release(): Promise<void>;
}

export const RUN_IN_PROGRESS_MESSAGE = "A run is already in progress";

function isAlive(pid: number): boolean {
	try {
		// signal 0 = no-op probe; throws ESRCH if process is gone, EPERM if alive but unowned.
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function tryWriteLock(lockPath: string): Promise<boolean> {
	try {
		await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	}
}

export async function acquireRunLock(baseDir: string): Promise<RunLock> {
	await mkdir(baseDir, { recursive: true });
	const lockPath = join(baseDir, ".run.lock");
	if (await tryWriteLock(lockPath)) return makeLock(lockPath);

	// Stale lock recovery: if the recorded PID is dead, the prior run crashed —
	// reclaim the lock. If the file is unreadable or PID is unparseable, treat
	// as held to stay safe.
	let stalePid: number | undefined;
	try {
		stalePid = Number.parseInt((await readFile(lockPath, "utf-8")).trim(), 10);
	} catch {
		throw new Error(RUN_IN_PROGRESS_MESSAGE);
	}
	if (!Number.isFinite(stalePid) || isAlive(stalePid)) {
		throw new Error(RUN_IN_PROGRESS_MESSAGE);
	}
	await unlink(lockPath).catch(() => {});
	if (await tryWriteLock(lockPath)) return makeLock(lockPath);
	throw new Error(RUN_IN_PROGRESS_MESSAGE);
}

function makeLock(lockPath: string): RunLock {
	return {
		async release() {
			await unlink(lockPath).catch(() => {});
		},
	};
}
