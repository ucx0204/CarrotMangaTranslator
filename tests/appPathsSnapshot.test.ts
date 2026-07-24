import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "C:\\unused-app-data",
  },
}));

import { getAppPaths } from "../src/main/appPaths";

describe("application path snapshot", () => {
  it("resolves process-scoped paths only once", () => {
    const first = getAppPaths();
    const second = getAppPaths();
    const repositoryRoot = resolve(__dirname, "..");

    expect(second).toBe(first);
    expect(second.dataRoot).toBe(repositoryRoot);
    expect(second.repoRoot).toBe(repositoryRoot);
    expect(second.libraryDir).toBe(join(repositoryRoot, "library"));
    expect(second.libraryDir).toBe(first.libraryDir);
    expect(second.llamaServerPath).toBe(first.llamaServerPath);
  });
});
