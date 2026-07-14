import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  nativeImage: {},
}));

import { detectImportImageFormat } from "../src/main/libraryStore/importImages";

describe("import image signatures", () => {
  it("detects jpeg, png, and webp headers", () => {
    expect(detectImportImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "jpeg",
    );
    expect(
      detectImportImageFormat(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("png");
    expect(
      detectImportImageFormat(
        Buffer.from("RIFF\x08\x00\x00\x00WEBP", "binary"),
      ),
    ).toBe("webp");
  });

  it("does not accept truncated or partial lookalike headers", () => {
    expect(detectImportImageFormat(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectImportImageFormat(Buffer.from("RIFF", "ascii"))).toBeNull();
    expect(
      detectImportImageFormat(
        Buffer.from("RIFF\x08\x00\x00\x00NOPE", "binary"),
      ),
    ).toBeNull();
  });
});
