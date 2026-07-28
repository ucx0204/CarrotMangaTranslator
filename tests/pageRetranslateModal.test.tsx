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
      screen.getByRole("button", { name: "사용" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "재번역 시작" }));

    expect(onStart).toHaveBeenCalledWith("auto", true);
    expect(onPersistDefaults).toHaveBeenCalledWith({
      blockModeDefault: "auto",
      naturalTextLayoutDefault: true,
    });
  });

  it("preserves an explicitly saved natural line layout off setting", () => {
    const { onPersistDefaults, onStart } = renderModal({
      naturalTextLayoutDefault: false,
    });

    expect(
      screen
        .getByRole("button", { name: "사용 안 함" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "재번역 시작" }));

    expect(onStart).toHaveBeenCalledWith("auto", false);
    expect(onPersistDefaults).toHaveBeenCalledWith({
      blockModeDefault: "auto",
      naturalTextLayoutDefault: false,
    });
  });
});
