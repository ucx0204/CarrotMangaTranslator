/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useSettingsLocalModelActions } from "../src/renderer/src/components/settingsModal/useSettingsLocalModelActions";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("settings local model action lifecycle", () => {
  it("ignores a file-picker result after the settings form unmounts", async () => {
    let resolveRequest:
      | ((value: { modelPath: string; detectedMmprojPath?: string }) => void)
      | undefined;
    const request = new Promise<{
      modelPath: string;
      detectedMmprojPath?: string;
    }>((resolve) => {
      resolveRequest = resolve;
    });
    window.mangaApi = createTestMangaGatewayStub({
      pickLocalModelFile: () => request,
    });
    const clearTestState = vi.fn();
    const setLocalModelPath = vi.fn();
    const setLocalMmprojPath = vi.fn();
    const view = renderHook(() =>
      useSettingsLocalModelActions({
        clearTestState,
        setters: { setLocalMmprojPath, setLocalModelPath },
      }),
    );

    let action: Promise<void> | undefined;
    act(() => {
      action = view.result.current.pickLocalModelFile();
    });
    view.unmount();
    await act(async () => {
      resolveRequest?.({
        modelPath: "C:/models/late.gguf",
        detectedMmprojPath: "C:/models/late.mmproj",
      });
      await action;
    });

    expect(clearTestState).not.toHaveBeenCalled();
    expect(setLocalModelPath).not.toHaveBeenCalled();
    expect(setLocalMmprojPath).not.toHaveBeenCalled();
  });
});
