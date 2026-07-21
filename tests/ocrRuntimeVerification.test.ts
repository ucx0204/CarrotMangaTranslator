import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { hasExpectedOcrPackages } =
  require("../src/main/runtime/ocr/runtime-verification.cjs") as {
    hasExpectedOcrPackages: (
      packageDir: string,
      options?: Record<string, unknown>,
    ) => boolean;
  };

const describeWindows = process.platform === "win32" ? describe : describe.skip;
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describeWindows("OCR runtime package verification", () => {
  it("requires every package used by the AMD Transformers detector", () => {
    const packageDir = mkdtempSync(join(tmpdir(), "ocr-rocm-packages-"));
    tempDirs.push(packageDir);
    const required = [
      "torch",
      "torchvision",
      "transformers",
      "paddlex",
      "paddleocr",
      "safetensors",
    ];
    const options = {
      ocrDevice: "gpu",
      ocrGpuBackend: "rocm-transformers",
    };

    for (const name of required) {
      mkdirSync(join(packageDir, name));
    }
    expect(hasExpectedOcrPackages(packageDir, options)).toBe(true);

    for (const name of required) {
      rmSync(join(packageDir, name), { recursive: true });
      expect(hasExpectedOcrPackages(packageDir, options)).toBe(false);
      mkdirSync(join(packageDir, name));
    }
  });
});
