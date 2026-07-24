import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiLocale } from "../src/shared/uiLocales";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { uiLocaleGateway } from "../src/renderer/src/api/uiLocaleGateway";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uiLocaleGateway", () => {
  it("fails clearly when the preload bridge is missing", () => {
    expect(() => uiLocaleGateway.getUiLocale()).toThrow(
      /UI locale API bridge/i,
    );
    expect(() => uiLocaleGateway.onUiLocaleChanged(() => undefined)).toThrow(
      /UI locale API bridge/i,
    );
  });

  it("supports the partial locale bridge used by renderer tests", async () => {
    let listener: ((locale: UiLocale) => void) | undefined;
    const unsubscribe = vi.fn();
    const api = createTestMangaGatewayStub({
      getUiLocale: vi.fn().mockResolvedValue("ja"),
      onUiLocaleChanged: vi.fn((callback: (locale: UiLocale) => void) => {
        listener = callback;
        return unsubscribe;
      }),
    });
    vi.stubGlobal("window", { mangaApi: api });

    await expect(uiLocaleGateway.getUiLocale()).resolves.toBe("ja");
    const callback = vi.fn();
    expect(uiLocaleGateway.onUiLocaleChanged(callback)).toBe(unsubscribe);
    listener?.("zh-Hant");
    expect(callback).toHaveBeenCalledWith("zh-Hant");
  });
});
