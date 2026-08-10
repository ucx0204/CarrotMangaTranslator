import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtimeConfig =
  require("../src/main/runtime/simple-page-ocr-runtime-config.cjs") as {
    buildPaddleOcrImportCheckScript: (
      options?: Record<string, unknown>,
    ) => string;
    buildPaddleOcrImportFailureMessage: (
      message: string,
      options?: Record<string, unknown>,
    ) => string;
    isOcrBackendPackageIdentityFailureText: (message: unknown) => boolean;
  };
const integrity =
  require("../src/main/runtime/ocr/requirements-integrity.cjs") as {
    validateBuiltinOcrRequirementsLock: (
      lockPath: string,
      variant: string,
    ) => void;
  };

const lockRoot = join(process.cwd(), "src", "main", "runtime", "ocr");

describe("OCR runtime package identity contracts", () => {
  const validLocks = [
    ["cpu", "requirements-ocr-cpu-win-py312.lock"],
    ["gpu-cu126", "requirements-ocr-gpu-cu126-win-py312.lock"],
    ["gpu-cu129", "requirements-ocr-gpu-cu129-win-py312.lock"],
    ["gpu-cuda-transformers-cu126", "requirements-ocr-cuda-tf-cu126-win.lock"],
    ["gpu-cuda-transformers-cu130", "requirements-ocr-cuda-tf-cu130-win.lock"],
    ["gpu-rocm-transformers", "requirements-ocr-rocm-win-py312.lock"],
  ] as const;

  for (const [variant, fileName] of validLocks) {
    it(`keeps ${variant} locked to its own backend`, () => {
      expect(() =>
        integrity.validateBuiltinOcrRequirementsLock(
          join(lockRoot, fileName),
          variant,
        ),
      ).not.toThrow();
    });
  }

  it("pins the exact Windows CPython 3.12 NVIDIA CUDA wheels and hashes", () => {
    const cu126 = readFileSync(
      join(lockRoot, "requirements-ocr-cuda-tf-cu126-win.lock"),
      "utf8",
    );
    const cu130 = readFileSync(
      join(lockRoot, "requirements-ocr-cuda-tf-cu130-win.lock"),
      "utf8",
    );

    expect(cu126).toContain("torch==2.9.1+cu126");
    expect(cu126).toContain("torchvision==0.24.1+cu126");
    expect(cu126).toContain(
      "f2f1c68c7957ed8b6b56fc450482eb3fa53947fb74838b03834a1760451cf60f",
    );
    expect(cu126).toContain(
      "54c1902bad62bd113f66dd3cc0368aa4d0005837100d3ab9dc823aebf945ead0",
    );
    expect(cu126).not.toMatch(/^torch==2\.9\.1 \\/m);
    expect(cu130).toContain("torch==2.9.1+cu130");
    expect(cu130).toContain("torchvision==0.24.1+cu130");
    expect(cu130).toContain(
      "cd3232a562ad2a2699d48130255e1b24c07dfe694a40dcd24fad683c752de121",
    );
    expect(cu130).toContain(
      "d31ceaded0d9b737471fa680ccd9e1acb6d5f0f70f03ef3a8d786a99c79da7cf",
    );
    expect(cu130).not.toMatch(/^torch==2\.9\.1 \\/m);
  });

  it("rejects a lock whose package backend does not match its variant", () => {
    const root = mkdtempSync(join(tmpdir(), "ocr-lock-mismatch-"));
    const lockPath = join(root, "bad.lock");
    writeFileSync(
      lockPath,
      "paddlepaddle==3.3.1 \\\n    --hash=sha256:deadbeef\n",
    );
    try {
      expect(() =>
        integrity.validateBuiltinOcrRequirementsLock(lockPath, "gpu-cu126"),
      ).toThrow("backend contract mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks package identity before GPU device availability", () => {
    const cuda = runtimeConfig.buildPaddleOcrImportCheckScript({
      ocrDevice: "gpu",
      ocrGpuBackend: "cuda",
      ocrGpuCudaTag: "cu126",
      ocrEngine: "transformers",
    });
    const rocm = runtimeConfig.buildPaddleOcrImportCheckScript({
      ocrDevice: "gpu",
      ocrGpuBackend: "rocm-transformers",
    });
    const cpu = runtimeConfig.buildPaddleOcrImportCheckScript({
      ocrDevice: "cpu",
    });

    expect(cuda).toContain('_expected_cuda_tag = "+cu126"');
    expect(cuda.indexOf("Unexpected NVIDIA CUDA PyTorch build")).toBeLessThan(
      cuda.indexOf("torch.cuda.is_available()"),
    );
    expect(rocm.indexOf("Unexpected AMD ROCm PyTorch build")).toBeLessThan(
      rocm.indexOf("torch.cuda.is_available()"),
    );
    expect(cpu).toContain("Unexpected CPU PaddlePaddle build");
  });

  it("reports a backend package mismatch instead of blaming the driver", () => {
    const detail =
      "AssertionError: Unexpected NVIDIA CUDA PyTorch build: expected +cu126, got 2.9.1+cpu";
    const message = runtimeConfig.buildPaddleOcrImportFailureMessage(detail, {
      ocrDevice: "gpu",
      ocrGpuBackend: "cuda",
      ocrGpuCudaTag: "cu126",
      ocrEngine: "transformers",
    });

    expect(runtimeConfig.isOcrBackendPackageIdentityFailureText(detail)).toBe(
      true,
    );
    expect(message).toContain("다른 백엔드 패키지");
    expect(message).toContain("2.9.1+cu126");
    expect(message).not.toContain("드라이버");
  });
});
