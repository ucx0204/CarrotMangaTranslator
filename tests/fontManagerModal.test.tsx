/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BLOCK_FONT_ID } from "../src/shared/blockFontCatalog";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { FontManagerModal } from "../src/renderer/src/components/FontManagerModal";
import { FontsProvider } from "../src/renderer/src/fonts/FontsProvider";
import { dismissToast, getToasts } from "../src/renderer/src/lib/toastStore";

afterEach(() => {
  cleanup();
  for (const item of getToasts()) {
    dismissToast(item.id);
  }
  document.getElementById("mgt-custom-fonts")?.remove();
  vi.restoreAllMocks();
});

describe("FontManagerModal", () => {
  it("keeps the modal open and reports a preference save failure", async () => {
    const error = new Error("disk full");
    const saveFontPreferences = vi.fn().mockRejectedValue(error);
    const onClose = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    Object.defineProperty(window, "mangaApi", {
      configurable: true,
      value: createTestMangaGatewayStub({
        getFontLibrary: async () => ({
          customFonts: [],
          preferences: {
            hiddenIds: [],
            favoriteIds: [],
            orderedIds: [],
            defaultFontId: DEFAULT_BLOCK_FONT_ID,
          },
        }),
        onFontLibraryChanged: () => () => undefined,
        saveFontPreferences,
      }),
    });

    render(
      <FontsProvider>
        <FontManagerModal onClose={onClose} />
      </FontsProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(saveFontPreferences).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(getToasts()).toContainEqual(
        expect.objectContaining({
          variant: "error",
          message: "폰트 설정을 저장하지 못했습니다.",
        }),
      ),
    );
    expect(consoleError).toHaveBeenCalledWith(error);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "폰트 관리" })).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "저장" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });
});
