import { describe, expect, it, vi } from "vitest";
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
    deleteSelectedBlock: vi.fn(),
    duplicateSelectedBlock: vi.fn(),
    selectWorkspaceTool: vi.fn(),
    startAreaTranslate: vi.fn(),
    updateSelectedBlock: vi.fn(),
  };
}

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
      { type: "selectTransformMode", mode: "curve" },
      { type: "applyFormat", scope: "selection", groupIds: ["font"] },
      { type: "applyBlockBackgroundOpacity", scope: "page" },
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

    expect(actions.updateSelectedBlock).toHaveBeenCalledWith({
      translatedText: "current update",
    });
    expect(actions.adjustSelectedBlockFontSize).toHaveBeenCalledWith(-1);
    expect(actions.deleteSelectedBlock).toHaveBeenCalledOnce();
    expect(actions.duplicateSelectedBlock).toHaveBeenCalledOnce();
    expect(actions.selectWorkspaceTool).toHaveBeenCalledWith("curve");
    expect(actions.applyFormatToScope).toHaveBeenCalledWith("selection", [
      "font",
    ]);
    expect(actions.applyBlockBackgroundOpacityToScope).toHaveBeenCalledWith(
      "page",
    );
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
});
