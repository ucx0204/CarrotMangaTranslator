import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..");

describe("error handling policy check", () => {
  it("uses Git's file list without requiring ripgrep", () => {
    const script = readFileSync(
      join(repoRoot, "scripts", "check-error-handling.cjs"),
      "utf8",
    );

    expect(script).toContain('"ls-files"');
    expect(script).toContain('"--cached"');
    expect(script).toContain('"--others"');
    expect(script).toContain('"--exclude-standard"');
    expect(script).not.toMatch(/execFileSync\(\s*"rg"/u);
  });

  it("keeps the JavaScript and TypeScript candidate extensions", () => {
    const script = readFileSync(
      join(repoRoot, "scripts", "check-error-handling.cjs"),
      "utf8",
    );
    const extensions = [".cjs", ".mjs", ".js", ".ts", ".tsx"];

    for (const extension of extensions) {
      expect(script).toContain(`"${extension}"`);
    }
  });
});
