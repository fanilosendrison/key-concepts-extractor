import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "kce-test-"));
}

export async function cleanupTempDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}

export function withTempDir(fn: (dir: string) => Promise<void>): () => Promise<void> {
	return async () => {
		const dir = await createTempDir();
		try {
			await fn(dir);
		} finally {
			await cleanupTempDir(dir);
		}
	};
}
