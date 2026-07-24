import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type ReexportRule = "unapproved-boundary" | "unapproved-source" | "wildcard";

type ReexportBoundaryChecker = {
  inspectSource: (
    file: string,
    sourceText: string,
  ) => Array<{
    file: string;
    line: number;
    rule: ReexportRule;
    source: string;
  }>;
  findReexportViolations: (repoRoot: string) => Array<{
    file: string;
    line: number;
    rule: ReexportRule;
    source: string;
  }>;
  listSourceFiles: (repoRoot: string) => string[];
};

const require = createRequire(import.meta.url);
const checker: ReexportBoundaryChecker = require("../scripts/check-reexport-boundaries.cjs");
const repoRoot = join(__dirname, "..");

describe("re-export boundary policy", () => {
  it("accepts a named export from an approved facade/source pair", () => {
    const source = `
      export {
        resolveDefaultAppSettings
      } from "./settings/appSettingsDefaults";
    `;

    expect(checker.inspectSource("src/main/appSettings.ts", source)).toEqual(
      [],
    );
  });

  it("rejects a re-export outside a documented boundary", () => {
    const violations = checker.inspectSource(
      "src/main/featureHelper.ts",
      'export { helper } from "./helper";',
    );

    expect(violations).toEqual([
      expect.objectContaining({
        rule: "unapproved-boundary",
        source: "./helper",
      }),
    ]);
  });

  it("rejects an undocumented source added to an approved facade", () => {
    const violations = checker.inspectSource(
      "src/main/appSettings.ts",
      'export { helper } from "./settings/hiddenHelper";',
    );

    expect(violations).toEqual([
      expect.objectContaining({
        rule: "unapproved-source",
        source: "./settings/hiddenHelper",
      }),
    ]);
  });

  it.each([
    'export * from "./settings/appSettingsDefaults";',
    'export * as defaults from "./settings/appSettingsDefaults";',
  ])("rejects wildcard forms even from an approved source", (source) => {
    expect(checker.inspectSource("src/main/appSettings.ts", source)).toEqual([
      expect.objectContaining({ rule: "wildcard" }),
    ]);
  });

  it("passes against every current source file in the repository", () => {
    expect(checker.listSourceFiles(repoRoot)).toContain(
      "src/main/appSettings.ts",
    );
    expect(checker.findReexportViolations(repoRoot)).toEqual([]);
  });
});
