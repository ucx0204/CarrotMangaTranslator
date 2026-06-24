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
    expect(script).toContain(
      'parser.add_argument("--dtype", default=os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE", "float32"))',
    );
    expect(script).toContain('"--text-detection-model-name"');
    expect(script).toContain(
      'os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_TEXT_DETECTION_MODEL_NAME")',
    );
    expect(script).toContain('"--text-recognition-model-name"');
    expect(script).toContain(
      'os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_TEXT_RECOGNITION_MODEL_NAME")',
    );
    expect(script).toContain('parser.add_argument(\n        "--merge-mode"');
    expect(script).toContain('if args.bbox_mode == "ocr":');
    expect(script).toContain("write_page_bboxes_from_ocr");
    expect(script).toContain(
      'merge_mode=resolve_textline_merge_mode(args, default="conservative")',
    );
    expect(script).toContain("should_merge_textline_boxes_conservative");
    expect(script).toContain('ocr_kwargs["engine"] = "transformers"');
    expect(script).toContain('ocr_kwargs["engine"] = engine');
    expect(script).toContain('ocr_kwargs["text_detection_model_name"]');
    expect(script).toContain('ocr_kwargs["text_recognition_model_name"]');
    expect(script).toContain(
      'os.environ.get("MANGA_TRANSLATOR_PADDLEOCR_ATTN", "eager")',
    );
    expect(script).toContain("should_retry_with_eager_attention");
    expect(script).toContain("apply_attention_implementation_to_engine_config");
    expect(script).toContain("model_kwargs");
    expect(script).toContain("scaled_dot_product_attention");
    expect(script).toContain("configure_torch_for_transformers_ocr");
    expect(script).toContain("MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN");
    expect(script).toContain("torch.backends.cudnn.enabled = False");
    expect(script).toContain('getattr(torch.backends, "miopen", None)');
    expect(script).toContain("predict_with_torch_inference_mode");
    expect(script).toContain('"ocr_version"');
    expect(script).toContain("PP-OCRv6");
    expect(script).toContain("import torch");
    expect(script).toContain("torch.cuda.is_available()");
    expect(script).toContain("torch.version");
    expect(script).toContain("import paddle");
    expect(script).toContain("paddle.device.is_compiled_with_cuda()");
  });

  it("filters unreliable OCR text only for the tiny recognizer", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain("def filter_candidate_ocr_text(");
    expect(script).toContain("def is_tiny_recognition_model(");
    expect(script).toContain('return "tiny_rec" in value.strip().lower()');
    expect(script).toContain("if not is_tiny_recognition_model(args):");
    expect(script).toContain("return cleaned");
    expect(script).toContain("def is_suspicious_tiny_rec_text(");
    expect(script).toContain("contains_common_simplified_chinese_artifact");
    expect(script).toContain("def is_reliable_tiny_no_kana_text(");
  });
});
