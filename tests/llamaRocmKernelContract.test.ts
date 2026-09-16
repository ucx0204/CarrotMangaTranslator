import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
type Runtime = {
  backend: string;
  dir: string;
  id: string;
  requiredFiles: Array<string | string[]>;
  requiresHipblasltKernels?: boolean;
};
const {
  resolveLemonadeLlamaRuntimeRocm,
  resolveSpeedLemonadeLlamaRuntimeRocm,
} =
  require("../src/main/runtime/model/lemonade-llama-runtime-contracts.cjs") as {
    resolveLemonadeLlamaRuntimeRocm: (target: string) => Runtime;
    resolveSpeedLemonadeLlamaRuntimeRocm: (target: string) => Runtime;
  };
const { hasRequiredLlamaRuntimeFiles, missingRequiredLlamaRuntimeFiles } =
  require("../src/main/runtime/model/runtime-files.cjs") as {
    hasRequiredLlamaRuntimeFiles: (dir: string, runtime: Runtime) => boolean;
    missingRequiredLlamaRuntimeFiles: (
      dir: string,
      runtime: Runtime,
    ) => string[];
  };

const rocblasMissing = "rocblas/library/*.dat|*.co|*.hsaco";
const hipblasltMissing = "hipblaslt/library/*.dat|*.co|*.hsaco";

function withRocblasFixture(runtime: Runtime, check: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "mgt-rocm-kernel-contract-"));
  try {
    for (const requirement of runtime.requiredFiles) {
      const name = Array.isArray(requirement) ? requirement[0] : requirement;
      writeFileSync(join(dir, name), "runtime fixture");
    }
    // The audited b1317 gfx103X ZIP includes this DLL, but no hipblaslt/ tree.
    writeFileSync(join(dir, "libhipblaslt.dll"), "bundled DLL");
    mkdirSync(join(dir, "rocblas", "library"), { recursive: true });
    writeFileSync(
      join(dir, "rocblas", "library", "Kernels.so-000-gfx1030.hsaco"),
      "kernel",
    );
    check(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pinned ROCm kernel-library contracts", () => {
  it("accepts the b1317 gfx103X archive without nonexistent hipBLASLt kernels (#108)", () => {
    const runtime = resolveSpeedLemonadeLlamaRuntimeRocm("gfx103X");
    expect(runtime.id).toBe("lemonade-llama-b1317-rocm-gfx103X");
    withRocblasFixture(runtime, (dir) => {
      expect(missingRequiredLlamaRuntimeFiles(dir, runtime)).toEqual([]);
      expect(hasRequiredLlamaRuntimeFiles(dir, runtime)).toBe(true);
      rmSync(join(dir, "hipblas.dll"));
      expect(missingRequiredLlamaRuntimeFiles(dir, runtime)).toContain(
        "hipblas.dll",
      );
      expect(hasRequiredLlamaRuntimeFiles(dir, runtime)).toBe(false);
    });
  });

  it("still rejects missing rocBLAS kernels on gfx103X", () => {
    const runtime = resolveSpeedLemonadeLlamaRuntimeRocm("gfx103X");
    withRocblasFixture(runtime, (dir) => {
      rmSync(join(dir, "rocblas"), { recursive: true });
      expect(missingRequiredLlamaRuntimeFiles(dir, runtime)).toEqual([
        rocblasMissing,
      ]);
      expect(hasRequiredLlamaRuntimeFiles(dir, runtime)).toBe(false);
    });
  });

  it.each(["gfx110X", "gfx1150", "gfx1151", "gfx120X", "gfx908", "gfx90a"])(
    "keeps hipBLASLt kernel checks for the b1317 %s contract",
    (target) => {
      const runtime = resolveSpeedLemonadeLlamaRuntimeRocm(target);
      withRocblasFixture(runtime, (dir) => {
        expect(missingRequiredLlamaRuntimeFiles(dir, runtime)).toEqual([
          hipblasltMissing,
        ]);
        expect(hasRequiredLlamaRuntimeFiles(dir, runtime)).toBe(false);
      });
    },
  );

  it("keeps the audited legacy gfx103X hipBLASLt subtree mandatory", () => {
    const runtime = resolveLemonadeLlamaRuntimeRocm("gfx103X");
    withRocblasFixture(runtime, (dir) => {
      expect(missingRequiredLlamaRuntimeFiles(dir, runtime)).toEqual([
        hipblasltMissing,
      ]);
      const kernels = join(dir, "hipblaslt", "library", "gfx1100");
      mkdirSync(kernels, { recursive: true });
      writeFileSync(join(kernels, "Kernels.hsaco"), "legacy kernel");
      expect(hasRequiredLlamaRuntimeFiles(dir, runtime)).toBe(true);
    });
  });

  it("requires both libraries when a descriptor has no explicit exception", () => {
    const runtime = resolveSpeedLemonadeLlamaRuntimeRocm("gfx103X");
    delete runtime.requiresHipblasltKernels;
    withRocblasFixture(runtime, (dir) => {
      expect(missingRequiredLlamaRuntimeFiles(dir, runtime)).toEqual([
        hipblasltMissing,
      ]);
      expect(hasRequiredLlamaRuntimeFiles(dir, runtime)).toBe(false);
    });
  });
});
