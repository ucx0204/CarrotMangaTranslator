import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type MockBoundaryChecker = {
  inspectSource: (
    file: string,
    sourceText: string,
  ) => Array<{ file: string; line: number; moduleName: string }>;
  isAllowedInternalBoundaryMock: (file: string, moduleName: string) => boolean;
};

const require = createRequire(import.meta.url);
const checker: MockBoundaryChecker = require("../scripts/check-test-mock-boundaries.cjs");

describe("test mock boundary policy", () => {
  it("rejects mocks of production implementation modules", () => {
    const source = `
      vi.mock("../src/main/logger", () => ({ logError: vi.fn() }));
      vi.doMock("../src/renderer/src/lib/toastStore", () => ({}));
    `;

    expect(checker.inspectSource("tests/example.test.ts", source)).toEqual([
      expect.objectContaining({ moduleName: "../src/main/logger", line: 2 }),
      expect.objectContaining({
        moduleName: "../src/renderer/src/lib/toastStore",
        line: 3,
      }),
    ]);
  });

  it("allows third-party and platform boundary mocks", () => {
    const source = `
      vi.mock("electron", () => ({ app: {} }));
      vi.mock("node:fs/promises", () => ({}));
    `;

    expect(checker.inspectSource("tests/example.test.ts", source)).toEqual([]);
  });

  it("allows only the file-specific environment adapter exceptions", () => {
    const moduleName = "../src/main/appPaths";
    expect(
      checker.isAllowedInternalBoundaryMock(
        "tests/libraryPaths.test.ts",
        moduleName,
      ),
    ).toBe(true);
    expect(
      checker.inspectSource(
        "tests/unrelated.test.ts",
        `vi.mock("${moduleName}", () => ({}));`,
      ),
    ).toEqual([
      expect.objectContaining({
        file: "tests/unrelated.test.ts",
        moduleName,
      }),
    ]);
  });
});
