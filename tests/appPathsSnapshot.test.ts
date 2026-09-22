import { join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "C:\\unused-app-data",
  },
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.mocked(existsSync).mockReset().mockReturnValue(false);
  vi.mocked(readdirSync).mockReset().mockReturnValue([]);
});

describe("application path snapshot", () => {
  it("resolves process-scoped paths only once", async () => {
    const { getAppPaths } = await import("../src/main/appPaths");
    const first = getAppPaths();
    const discoveryCalls = vi.mocked(existsSync).mock.calls.length;
    const second = getAppPaths();
    const repositoryRoot = resolve(__dirname, "..");

    expect(second).toBe(first);
    expect(second.dataRoot).toBe(repositoryRoot);
    expect(second.repoRoot).toBe(repositoryRoot);
    expect(second.libraryDir).toBe(join(repositoryRoot, "library"));
    expect(second.libraryDir).toBe(first.libraryDir);
    expect(second.llamaServerPath).toBe(first.llamaServerPath);
    expect(existsSync).toHaveBeenCalledTimes(discoveryCalls);
  });

  it.each([true, false])(
    "selects the bundled server with GPU backend available=%s",
    async (gpuAvailable) => {
      const toolsDir = resolve(__dirname, "../tools");
      const binary =
        process.platform === "win32" ? "llama-server.exe" : "llama-server";
      const firstServer = join(toolsDir, "llama-b10621-metal-arm64", binary);
      const gpuDir = join(toolsDir, "beellama-v0.2.0-cuda12.4");
      const gpuServer = join(gpuDir, binary);
      const files = new Set([firstServer, gpuServer]);
      if (gpuAvailable) files.add(join(gpuDir, "ggml-cuda.dll"));
      vi.mocked(existsSync).mockImplementation((path) =>
        files.has(String(path)),
      );
      const { getAppPaths } = await import("../src/main/appPaths");

      expect(getAppPaths().llamaServerPath).toBe(
        gpuAvailable ? gpuServer : firstServer,
      );
    },
  );
});
