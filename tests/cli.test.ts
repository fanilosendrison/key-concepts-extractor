import { describe, expect, it } from "vitest";
import { parseCli } from "../src/cli/index.js";

describe("CLI", () => {
  it("T-CLI-01: parse run command", () => {
    const result = parseCli([
      "node",
      "kce",
      "run",
      "--prompt",
      "test query",
      "--files",
      "a.md",
      "b.txt",
    ]);
    expect(result.command).toBe("run");
    expect(result.options?.prompt).toBe("test query");
    expect(result.options?.files).toEqual(["a.md", "b.txt"]);
  });

  it("T-CLI-02: no args shows usage", () => {
    const result = parseCli(["node", "kce"]);
    expect(result.exitCode).toBe(1);
    expect(result.usage).toBeDefined();
    expect(result.usage).toMatch(/usage/i);
  });

  it("T-CLI-03: history command", () => {
    const result = parseCli(["node", "kce", "history"]);
    expect(result.command).toBe("history");
  });
});
