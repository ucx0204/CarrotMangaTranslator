import { describe, expect, it } from "vitest";

const { isPaddleOcrModelAssetLoadFailure } =
  require("../src/main/runtime/model/paddle-model-validation.cjs") as {
    isPaddleOcrModelAssetLoadFailure: (value: unknown) => boolean;
  };

describe("Paddle OCR model failure classification", () => {
  it("does not treat normal model startup followed by an import failure as cache corruption", () => {
    const error = {
      stderrPreview: [
        "Creating model: ('PP-OCRv6_medium_det', None, None)",
        "Could not import module 'AutoImageProcessor'. Are this object's requirements defined correctly?",
      ].join("\n"),
    };

    expect(isPaddleOcrModelAssetLoadFailure(error)).toBe(false);
  });

  it("recognizes actual JSON and empty-model parse failures", () => {
    expect(
      isPaddleOcrModelAssetLoadFailure(
        "nlohmann::json::exception::parse_error.101: parse error",
      ),
    ).toBe(true);
    expect(
      isPaddleOcrModelAssetLoadFailure({
        message: "Creating model: ('PP-OCRv6_medium_det', None, None)",
        cause:
          "json.exception.parse_error.101: attempting to parse an empty input",
      }),
    ).toBe(true);
  });
});
