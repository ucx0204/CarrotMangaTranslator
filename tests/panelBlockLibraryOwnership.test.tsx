/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorPanelContainer } from "../src/renderer/src/panels/EditorPanelContainer";
import {
  PanelSessionContext,
  type PanelSessionValue,
} from "../src/renderer/src/panels/panelSession";

afterEach(cleanup);

describe("detached editor block-library ownership", () => {
  it("delegates opening to the main session without mounting a local modal", () => {
    const onOpenBlockLibrary = vi.fn();
    render(
      <PanelSessionContext.Provider
        value={makePanelSession({ onOpenBlockLibrary })}
      >
        <EditorPanelContainer />
      </PanelSessionContext.Provider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "블록 라이브러리 열기" }),
    );

    expect(onOpenBlockLibrary).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

function makePanelSession(
  overrides: Partial<PanelSessionValue> = {},
): PanelSessionValue {
  return {
    areaTranslateAvailable: false,
    areaTranslateSelecting: false,
    blockStylePresets: [],
    canCreateStylePreset: false,
    disableChapterApply: false,
    editorDisabled: false,
    editorFloating: false,
    editorPoppedOut: false,
    onAdjustFontSize: () => undefined,
    onApplyBlockBackgroundOpacity: () => undefined,
    onApplyFormat: () => undefined,
    onApplyStylePreset: () => undefined,
    onBackToPageBlocks: () => undefined,
    onCreateStylePreset: async () => false,
    onDeleteBlock: () => undefined,
    onDeleteStylePreset: async () => false,
    onDockEditorWindow: () => undefined,
    onDuplicateBlock: () => undefined,
    onEraseBlockOriginal: () => undefined,
    onFitBlockBubble: () => undefined,
    onInsertBlockLibraryEntry: () => undefined,
    onOpenBlockLibrary: () => undefined,
    onPopOutEditor: () => undefined,
    onRemoveBubbleLayout: () => undefined,
    onSelectTransformMode: () => undefined,
    onStartAreaTranslate: () => undefined,
    onToggleEditorFloat: () => undefined,
    onUpdateBlock: () => undefined,
    selectedBlock: null,
    selectedBlockCount: 0,
    selectedPageSize: { width: 1200, height: 1800 },
    showDetachControls: false,
    transformMode: "select",
    ...overrides,
  };
}
