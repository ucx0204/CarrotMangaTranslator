import { describe, expect, it } from "vitest";
import { createWebImageRequestReferrer } from "../src/main/webImportDownload";

describe("createWebImageRequestReferrer", () => {
  it("keeps the full page URL for a same-origin image", () => {
    expect(
      createWebImageRequestReferrer(
        "https://example.com/chapter/1?view=all",
        "https://example.com/images/1.jpg",
      ),
    ).toBe("https://example.com/chapter/1?view=all");
  });

  it("uses only the origin for a cross-origin image", () => {
    expect(
      createWebImageRequestReferrer(
        "https://page.example/chapter/1",
        "https://cdn.example/uploads/1.jpg",
      ),
    ).toBe("https://page.example/");
  });

  it("omits the referrer on an HTTPS to HTTP downgrade", () => {
    expect(
      createWebImageRequestReferrer(
        "https://example.com/chapter/1",
        "http://cdn.example.com/1.jpg",
      ),
    ).toBeNull();
  });
});
