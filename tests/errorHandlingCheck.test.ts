import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type RuleName =
  | "promise-catch-undefined"
  | "promise-catch-empty-block"
  | "empty-catch-block"
  | "implicit-catch-sentinel";

type ErrorHandlingChecker = {
  inspectSource: (
    file: string,
    sourceText: string,
  ) => Array<{ file: string; line: number; rule: RuleName }>;
  isCandidateFile: (file: string) => boolean;
  listCandidateFiles: (repoRoot: string) => string[];
};

const require = createRequire(import.meta.url);
const checker: ErrorHandlingChecker = require("../scripts/check-error-handling.cjs");
const repoRoot = join(__dirname, "..");

describe("error handling policy check", () => {
  it.each([".cjs", ".mjs", ".js", ".ts", ".tsx"])(
    "analyzes %s source files",
    (extension) => {
      expect(checker.isCandidateFile(`src/example${extension}`)).toBe(true);
    },
  );

  it("lists tracked and untracked source candidates through the repository", () => {
    const files = checker.listCandidateFiles(repoRoot);

    expect(files).toContain("scripts/check-error-handling.cjs");
    expect(files).toContain("src/main/index.ts");
    expect(files.every((file) => checker.isCandidateFile(file))).toBe(true);
  });

  it.each([
    {
      source: "task.catch(() => undefined);",
      rule: "promise-catch-undefined",
    },
    {
      source: "task.catch(() => {});",
      rule: "promise-catch-empty-block",
    },
    {
      source: "try { work(); } catch (error) {}",
      rule: "empty-catch-block",
    },
    {
      source:
        "function run() { try { work(); } catch (error) { return null; } }",
      rule: "implicit-catch-sentinel",
    },
  ] satisfies Array<{ source: string; rule: RuleName }>)(
    "reports $rule from parsed behavior",
    ({ source, rule }) => {
      expect(checker.inspectSource("fixture.ts", source)).toEqual([
        expect.objectContaining({ file: "fixture.ts", rule }),
      ]);
    },
  );

  it("accepts an explicitly documented optional boundary", () => {
    const source = `
      try {
        probeOptionalTool();
      } catch (_error) {
        // error-policy-allow: optional tool detection
      }
    `;

    expect(checker.inspectSource("fixture.ts", source)).toEqual([]);
  });
});
