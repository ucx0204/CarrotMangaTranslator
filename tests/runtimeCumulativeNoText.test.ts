import { describe, expect, it } from "vitest";

const { shouldSkipModelRequest } =
  require("../src/main/runtime/transport/translation-request.cjs") as {
    shouldSkipModelRequest: (
      result: { noTextDetected: boolean },
      options: Record<string, unknown>,
    ) => boolean;
  };

describe("runtime cumulative no-text handling", () => {
  it("keeps the legacy no-text shortcut outside cumulative mode", () => {
    expect(
      shouldSkipModelRequest(
        { noTextDetected: true },
        { sourceLanguage: "ja", collectPageContext: false },
      ),
    ).toBe(true);
  });

  it("does not skip the image model when cumulative context is requested", () => {
    expect(
      shouldSkipModelRequest(
        { noTextDetected: true },
        { sourceLanguage: "ja", collectPageContext: true },
      ),
    ).toBe(false);
  });
});
