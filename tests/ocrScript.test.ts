import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("PaddleOCR-VL bbox script", () => {
  const scriptPath = join(
    process.cwd(),
    "src",
    "main",
    "runtime",
    "paddleocr-vl-bboxes.py",
  );

  it("imports PIL Image at module scope for helper functions", () => {
    const script = readFileSync(scriptPath, "utf8");
    const importIndex = script.indexOf("from PIL import Image");
    const mainIndex = script.indexOf("def main()");
    const helperIndex = script.indexOf("def write_page_bboxes");

    expect(importIndex).toBeGreaterThanOrEqual(0);
    expect(importIndex).toBeLessThan(mainIndex);
    expect(importIndex).toBeLessThan(helperIndex);
  });

  it("keeps VL as the default mode and adds an OCR-only Transformers path", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain(
      'parser.add_argument("--bbox-mode", default=os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE", "vl")',
    );
    expect(script).toContain(
      'parser.add_argument("--engine", default=os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_ENGINE", "paddle"))',
    );
    expect(script).toContain('if args.bbox_mode == "ocr":');
    expect(script).toContain("write_page_bboxes_from_ocr");
    expect(script).toContain('ocr_kwargs["engine"] = "transformers"');
    expect(script).toContain('"ocr_version"');
    expect(script).toContain("PP-OCRv6");
    expect(script).toContain("import torch");
    expect(script).toContain("torch.cuda.is_available()");
    expect(script).toContain("torch.version");
    expect(script).toContain("import paddle");
    expect(script).toContain("paddle.device.is_compiled_with_cuda()");
  });
});
