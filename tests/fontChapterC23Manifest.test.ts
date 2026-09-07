import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../src/main/pipeline/fontChapterC18Manifest.json";

describe("approved C23 runtime binding", () => {
  it("binds every shipped algorithm and keeps a distinct rollback-safe asset root", () => {
    expect(manifest.version).toBe("c23.0");
    expect(manifest.assetDirectory).toBe("font-chapter-c18/c23-v1");
    const root = resolve("src/main/runtime/font-chapter-c18");
    expect(manifest.runtimeSources.map((row) => row.path).sort()).toEqual(
      readdirSync(root)
        .filter((name) => name.endsWith(".py"))
        .sort(),
    );
    for (const row of manifest.runtimeSources) {
      const bytes = readFileSync(resolve(root, row.path));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.sha256);
    }
  });
});
