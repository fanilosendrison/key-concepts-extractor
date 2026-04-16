import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { InputFile } from "../domain/types.js";

export async function loadInputFiles(paths: string[]): Promise<InputFile[]> {
	return Promise.all(
		paths.map(async (path) => ({
			name: basename(path),
			content: await readFile(path, "utf-8"),
		})),
	);
}
