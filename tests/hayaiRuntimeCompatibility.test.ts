import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runnerPath = resolve("src/main/runtime/hayai-bboxes.py");
const runner = readFileSync(runnerPath, "utf8");
const prepass = readFileSync(
  resolve("src/main/textDetection/hayaiRegionPrepass.ts"),
  "utf8",
);

describe("HayaiOCR managed runner contract", () => {
  it("registers isolated Windows DLL directories before importing PyTorch", () => {
    const setup = runner.indexOf(
      "configure_windows_dll_search_path()\n\nimport torch",
    );
    expect(setup).toBeGreaterThan(0);
    expect(runner).toContain("MANGA_TRANSLATOR_OCR_DLL_DIRS");
    expect(runner).toContain("os.add_dll_directory");
  });

  it("rejects mismatched CUDA and ROCm PyTorch packages before model loading", () => {
    expect(runner).toContain("MANGA_TRANSLATOR_OCR_GPU_BACKEND");
    expect(runner).toContain('getattr(torch.version, "hip", None)');
    expect(runner).toContain('getattr(torch.version, "cuda", None)');
    expect(runner).toContain("requested the AMD ROCm runtime");
    expect(runner).toContain("requested the NVIDIA CUDA runtime");
    expect(
      runner.indexOf("configure_requested_device(args.device)"),
    ).toBeLessThan(runner.indexOf("snapshot_download("));
  });

  it("runs the same pinned model on an explicitly selected CPU", () => {
    expect(runner).toContain('return torch.device("cpu"), "CPU"');
    expect(runner).toContain('print("[hayai-ocr] using CPU"');
    expect(runner).not.toContain("Select Legacy (Paddle OCR)");
  });

  it("preserves the pinned F32 inference path and only reduces batch size on OOM", () => {
    expect(runner).toContain("with torch.inference_mode()");
    expect(runner).toContain("recognize_batch_resilient");
    expect(runner).toContain("is_gpu_out_of_memory");
    expect(runner).toContain("release_gpu_memory()");
    expect(runner).not.toContain("torch.autocast");
    expect(runner).not.toContain("float16");
    expect(runner).not.toContain(".half()");
  });

  it("does not expose the detector project's brand as the OCR pipeline name", () => {
    expect(runner).not.toMatch(/koharu/i);
    expect(prepass).not.toMatch(/koharu/i);
    expect(prepass).toContain("detectPageTextRegions");
    expect(runner).toContain('OUTPUT_SCHEMA = "hayai-ocr-regions-v1"');
  });
});
