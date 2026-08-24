// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageRetranslateModal } from "../src/renderer/src/components/PageRetranslateModal";
import type { UiSettings } from "../src/shared/settingsTypes";

function renderModal(uiSettings?: UiSettings) {
  const onStart = vi.fn();
  const onPersistDefaults = vi.fn();
  render(
    <PageRetranslateModal
      pageName="page.png"
      blockCount={2}
      uiSettings={uiSettings}
      onStart={onStart}
      onPersistDefaults={onPersistDefaults}
      onClose={vi.fn()}
    />,
  );
  return { onPersistDefaults, onStart };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PageRetranslateModal", () => {
  it("defaults natural line layout on when no UI setting exists", () => {
    const { onPersistDefaults, onStart } = renderModal();

    expect(
      screen
        .getByRole("switch", { name: "자연스러운 줄 나눔" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("switch", { name: "폰트 자동 맞춤" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(
      screen.getByRole("button", { name: "이 페이지 다시 번역" }),
    );

    expect(onStart).toHaveBeenCalledWith("auto", true, false);
    expect(onPersistDefaults).not.toHaveBeenCalled();
  });

  it("preserves an explicitly saved natural line layout off setting", () => {
    const { onPersistDefaults, onStart } = renderModal({
      naturalTextLayoutDefault: false,
    });

    expect(
      screen
        .getByRole("switch", { name: "자연스러운 줄 나눔" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "다음 번역의 기본값으로 저장",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "이 페이지 다시 번역" }),
    );

    expect(onStart).toHaveBeenCalledWith("auto", false, false);
    expect(onPersistDefaults).toHaveBeenCalledWith({
      autoFontMatchingDefault: false,
      blockModeDefault: "auto",
      naturalTextLayoutDefault: false,
    });
  });

  it("shows and forwards the saved automatic font setting", () => {
    const { onPersistDefaults, onStart } = renderModal({
      autoFontMatchingDefault: true,
    });

    expect(
      screen
        .getByRole("switch", { name: "폰트 자동 맞춤" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "다음 번역의 기본값으로 저장",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "이 페이지 다시 번역" }),
    );

    expect(onStart).toHaveBeenCalledWith("auto", true, true);
    expect(onPersistDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ autoFontMatchingDefault: true }),
    );
  });
});
