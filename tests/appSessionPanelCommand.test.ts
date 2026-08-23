import { describe, expect, it, vi } from "vitest";
import type { BlockLibraryEntryV1 } from "../src/shared/blockLibrary";
import type { PanelCommand } from "../src/shared/panelBridgeTypes";
import {
  dispatchPanelCommand,
  type PanelCommandTarget,
} from "../src/renderer/src/app/session/panelCommandDispatcher";

function createTarget(): PanelCommandTarget {
  return {
    adjustSelectedBlockFontSize: vi.fn(),
    applyBlockBackgroundOpacityToScope: vi.fn(),
    applyFormatToScope: vi.fn(),
    applyStylePreset: vi.fn(),
    deleteStylePreset: vi.fn(),
    deleteSelectedBlock: vi.fn(),
    duplicateSelectedBlock: vi.fn(),
    openBlockLibrary: vi.fn(),
    insertBlockLibraryEntry: vi.fn(),
    eraseBlockOriginal: vi.fn(),
    fitBlockBubble: vi.fn(),
    removeSelectedBlockBubbleLayout: vi.fn(),
    selectWorkspaceTool: vi.fn(),
    startAreaTranslate: vi.fn(),
    updateBlock: vi.fn(),
  };
}

const libraryEntry: BlockLibraryEntryV1 = {
  schemaVersion: 1,
  id: "library-entry",
  name: "효과음",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  lastUsedAt: "2026-08-23T00:00:00.000Z",
  block: {
    sourceText: "ドン",
    translatedText: "쾅",
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 48,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    size: { w: 240, h: 180 },
  },
};

describe("panel command dispatch", () => {
  it.each([
    {
      type: "updateBlock",
      blockId: "stale-block",
      patch: { translatedText: "stale update" },
    },
    { type: "adjustFontSize", blockId: "stale-block", adjustment: 1 },
    { type: "deleteBlock", blockId: "stale-block" },
    { type: "duplicateBlock", blockId: "stale-block" },
    { type: "eraseBlockOriginal", blockId: "stale-block" },
    { type: "fitBlockBubble", blockId: "stale-block" },
    { type: "removeBubbleLayout", blockId: "stale-block" },
    {
      type: "applyStylePreset",
      blockId: "stale-block",
      presetId: "style-preset:dialogue",
    },
  ] satisfies PanelCommand[])("rejects a stale $type command", (command) => {
    const actions = createTarget();

    const accepted = dispatchPanelCommand({
      actions,
      busy: false,
      command,
      selectedBlockId: "current-block",
    });

    expect(accepted).toBe(false);
    expect(
      Object.values(actions).every(
        (action) => !vi.mocked(action).mock.calls.length,
      ),
    ).toBe(true);
  });

  it("dispatches every command to the matching behavior", () => {
    const actions = createTarget();
    const commands = [
      {
        type: "updateBlock",
        blockId: "current-block",
        patch: { translatedText: "current update" },
      },
      { type: "adjustFontSize", blockId: "current-block", adjustment: -1 },
      { type: "deleteBlock", blockId: "current-block" },
      { type: "duplicateBlock", blockId: "current-block" },
      { type: "openBlockLibrary" },
      { type: "eraseBlockOriginal", blockId: "current-block" },
      { type: "fitBlockBubble", blockId: "current-block" },
      { type: "removeBubbleLayout", blockId: "current-block" },
      { type: "selectTransformMode", mode: "curve" },
      { type: "applyFormat", scope: "selection", groupIds: ["font"] },
      {
        type: "applyStylePreset",
        blockId: "current-block",
        presetId: "style-preset:dialogue",
      },
      { type: "deleteStylePreset", presetId: "style-preset:dialogue" },
      { type: "applyBlockBackgroundOpacity", scope: "page" },
      { type: "insertBlockLibraryEntry", entry: libraryEntry },
      { type: "startAreaTranslate" },
    ] satisfies PanelCommand[];

    for (const command of commands) {
      expect(
        dispatchPanelCommand({
          actions,
          busy: false,
          command,
          selectedBlockId: "current-block",
        }),
      ).toBe(true);
    }

    expect(actions.updateBlock).toHaveBeenCalledWith("current-block", {
      translatedText: "current update",
    });
    expect(actions.adjustSelectedBlockFontSize).toHaveBeenCalledWith(-1);
    expect(actions.deleteSelectedBlock).toHaveBeenCalledOnce();
    expect(actions.duplicateSelectedBlock).toHaveBeenCalledOnce();
    expect(actions.openBlockLibrary).toHaveBeenCalledOnce();
    expect(actions.eraseBlockOriginal).toHaveBeenCalledWith("current-block");
    expect(actions.fitBlockBubble).toHaveBeenCalledWith("current-block");
    expect(actions.removeSelectedBlockBubbleLayout).toHaveBeenCalledOnce();
    expect(actions.selectWorkspaceTool).toHaveBeenCalledWith("curve");
    expect(actions.applyFormatToScope).toHaveBeenCalledWith("selection", [
      "font",
    ]);
    expect(actions.applyStylePreset).toHaveBeenCalledWith(
      "style-preset:dialogue",
    );
    expect(actions.deleteStylePreset).toHaveBeenCalledWith(
      "style-preset:dialogue",
    );
    expect(actions.applyBlockBackgroundOpacityToScope).toHaveBeenCalledWith(
      "page",
    );
    expect(actions.insertBlockLibraryEntry).toHaveBeenCalledWith(libraryEntry);
    expect(actions.startAreaTranslate).toHaveBeenCalledOnce();
  });

  it("rejects commands while any workflow is busy", () => {
    const actions = createTarget();

    const accepted = dispatchPanelCommand({
      actions,
      busy: true,
      command: { type: "startAreaTranslate" },
      selectedBlockId: null,
    });

    expect(accepted).toBe(false);
    expect(actions.startAreaTranslate).not.toHaveBeenCalled();
  });

  it("opens the library even while editing actions are busy", () => {
    const actions = createTarget();

    expect(
      dispatchPanelCommand({
        actions,
        busy: true,
        command: { type: "openBlockLibrary" },
        selectedBlockId: null,
      }),
    ).toBe(true);
    expect(actions.openBlockLibrary).toHaveBeenCalledOnce();
  });
});
