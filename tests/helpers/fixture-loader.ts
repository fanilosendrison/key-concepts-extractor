import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(HERE, "..", "fixtures");

export function loadFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES_ROOT, relativePath), "utf-8");
}

export function loadJsonFixture<T>(relativePath: string): T {
  return JSON.parse(loadFixture(relativePath)) as T;
}
