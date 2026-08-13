import { describe, expect, it } from "vitest";
import {
  assertPublicWebImportUrl,
  canonicalizeWebImageUrl,
  isPublicIpAddress,
  WebImportUrlError,
} from "../src/main/webImportUrlPolicy";

describe("web import URL policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("blocks non-public address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    },
  );

  it("rejects credentials, non-http schemes and private DNS answers", async () => {
    await expect(
      assertPublicWebImportUrl(
        "https://user:pass@example.com/page",
        async () => [{ address: "93.184.216.34", family: 4 }],
      ),
    ).rejects.toMatchObject({ reason: "invalid-url" });
    await expect(
      assertPublicWebImportUrl("file:///etc/passwd"),
    ).rejects.toBeInstanceOf(WebImportUrlError);
    await expect(
      assertPublicWebImportUrl("https://example.com", async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toMatchObject({ reason: "private-address" });
  });

  it("normalizes safe image URLs and strips fragments", () => {
    expect(canonicalizeWebImageUrl("https://example.com/a.jpg#part")).toBe(
      "https://example.com/a.jpg",
    );
    expect(canonicalizeWebImageUrl("data:image/png;base64,AA==")).toBeNull();
  });
});
