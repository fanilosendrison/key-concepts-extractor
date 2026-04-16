import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireRunLock } from "../src/infra/run-lock.js";
import { cleanupTempDir, createTempDir } from "./helpers/temp-dir.js";

describe("acquireRunLock (NIB-M-CLI §3.5, single concurrent run)", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await createTempDir();
	});

	afterEach(async () => {
		await cleanupTempDir(dir);
	});

	it("T-LOCK-01: first acquire succeeds", async () => {
		const lock = await acquireRunLock(dir);
		expect(lock).toBeDefined();
		await lock.release();
	});

	it("T-LOCK-02: second acquire while first held throws", async () => {
		const first = await acquireRunLock(dir);
		await expect(acquireRunLock(dir)).rejects.toThrow(/already in progress|locked/i);
		await first.release();
	});

	it("T-LOCK-03: re-acquire after release succeeds", async () => {
		const first = await acquireRunLock(dir);
		await first.release();
		const second = await acquireRunLock(dir);
		await second.release();
	});
});
