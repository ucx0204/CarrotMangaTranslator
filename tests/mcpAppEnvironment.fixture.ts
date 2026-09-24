import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

/** Use the real packaged path resolver and an isolated data root. Only Electron's
 * process/native boundary is replaced; no application or storage module is mocked. */
export async function mcpAppEnvironment(nativeImage: unknown = {}) {
  const root = await mkdtemp(join(tmpdir(), "mcp-app-environment-"));
  const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    writable: true,
    value: root,
  });
  vi.stubEnv("MANGA_TRANSLATOR_DATA_ROOT", root);
  vi.resetModules();
  vi.doMock("electron", () => ({
    app: { isPackaged: true, getPath: () => root },
    nativeImage,
  }));
  return {
    root,
    libraryDir: join(root, "library"),
    async close() {
      vi.doUnmock("electron");
      vi.resetModules();
      vi.unstubAllEnvs();
      if (resources) Object.defineProperty(process, "resourcesPath", resources);
      else Reflect.deleteProperty(process, "resourcesPath");
      await rm(root, { recursive: true, force: true });
    },
  };
}
