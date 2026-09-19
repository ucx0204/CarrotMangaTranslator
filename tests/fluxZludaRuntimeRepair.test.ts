import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureFluxZludaSupportRuntime } from "../src/main/inpainting/fluxAssets/zludaRuntime";
import {
  CUDA_REDIST_MANIFEST_URL,
  FLUX_ZLUDA_SUPPORT_RUNTIME_DIR,
} from "../src/main/inpainting/fluxAssets/constants";
import { runtimeMarkerPath } from "../src/main/inpainting/fluxAssets/cudaRuntime";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe("ZLUDA cuRAND support cache repair", () => {
  it.each(["missing", "empty", "directory"])(
    "preserves an old %s cache when its replacement cannot be downloaded",
    async (mode) => {
      const runtimeDir = await mkdtemp(join(tmpdir(), "mgt-zluda-support-"));
      roots.push(runtimeDir);
      const supportDir = join(runtimeDir, FLUX_ZLUDA_SUPPORT_RUNTIME_DIR);
      await mkdir(supportDir, { recursive: true });
      const dll = join(supportDir, "curand64_10.dll");
      if (mode === "empty") await writeFile(dll, "");
      if (mode === "directory") await mkdir(dll);
      const marker = JSON.stringify({ cudaManifest: CUDA_REDIST_MANIFEST_URL });
      await writeFile(runtimeMarkerPath(supportDir), marker);
      await writeFile(join(supportDir, "preserve-me"), "old runtime");
      const failure = new Error("offline during repair");
      const fetch = vi.fn().mockRejectedValue(failure);
      vi.stubGlobal("fetch", fetch);
      await expect(ensureFluxZludaSupportRuntime({ runtimeDir })).rejects.toBe(
        failure,
      );
      expect(fetch).toHaveBeenCalledOnce();
      expect(await readFile(runtimeMarkerPath(supportDir), "utf8")).toBe(
        marker,
      );
      expect(await readFile(join(supportDir, "preserve-me"), "utf8")).toBe(
        "old runtime",
      );
      expect((await readdir(runtimeDir)).sort()).toEqual(
        [".downloads", FLUX_ZLUDA_SUPPORT_RUNTIME_DIR].sort(),
      );
    },
  );
});
