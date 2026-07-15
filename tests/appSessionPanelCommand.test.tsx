/** @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelCommand } from "../src/shared/panelBridgeTypes";

const state = vi.hoisted(() => {
  const actions = {
    updateSelectedBlock: vi.fn(),
    adjustSelectedBlockFontSize: vi.fn(),
    deleteSelectedBlock: vi.fn(),
    duplicateSelectedBlock: vi.fn(),
    applyFormatToScope: vi.fn(),
    applyBlockBackgroundOpacityToScope: vi.fn(),
  };
  return {
    actions,
    panelCommandHandler: null as ((command: PanelCommand) => void) | null,
    chapter: {
      core: { workspacePanelRef: { current: null } },
      derivedState: { selectedBlock: { id: "current-block" } },
      uiState: {
        translationFlowActive: false,
        zoomInWorkspace: vi.fn(),
        zoomOutWorkspace: vi.fn(),
        selectWorkspaceTool: vi.fn(),
      },
    },
    inpainting: {
      inpaintingBridge: { contextValue: { jobActive: false } },
      pointerHandlers: { startRegionTranslationSelection: vi.fn() },
    },
    translation: {
      actions,
      blockEditingActions: actions,
      workspaceHistory: { busy: false },
    },
  };
});

vi.mock("../src/renderer/src/app/session/useChapterSessionController", () => ({
  useChapterSessionController: () => state.chapter,
}));
vi.mock("../src/renderer/src/app/session/useTranslationController", () => ({
  useTranslationController: () => state.translation,
}));
vi.mock("../src/renderer/src/app/session/useInpaintingController", () => ({
  useInpaintingController: () => state.inpainting,
}));
vi.mock("../src/renderer/src/app/session/useAppSessionShortcuts", () => ({
  useAppSessionShortcuts: vi.fn(),
}));
vi.mock("../src/renderer/src/hooks/useWorkspaceWheelZoom", () => ({
  useWorkspaceWheelZoom: vi.fn(),
}));
vi.mock("../src/renderer/src/app/session/buildPanelSyncState", () => ({
  buildPanelSyncState: vi.fn(() => ({})),
}));
vi.mock("../src/renderer/src/app/session/createAppSessionViewProps", () => ({
  createAppSessionViewProps: vi.fn(() => ({})),
}));
vi.mock("../src/renderer/src/panels/usePanelBridgeHost", () => ({
  usePanelBridgeHost: ({
    onCommand,
  }: {
    onCommand: (command: PanelCommand) => void;
  }) => {
    state.panelCommandHandler = onCommand;
    return {
      openPanelIds: [],
      openEditorWindow: vi.fn(),
      closeEditorWindow: vi.fn(),
    };
  },
}));

import { useAppSessionModel } from "../src/renderer/src/app/useAppSessionModel";

describe("useAppSessionModel panel command target safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.panelCommandHandler = null;
  });

  it("rejects every stale block command before invoking selection actions", () => {
    renderHook(() => useAppSessionModel());
    const staleCommands = [
      {
        type: "updateBlock",
        blockId: "stale-block",
        patch: { translatedText: "stale update" },
      },
      {
        type: "adjustFontSize",
        blockId: "stale-block",
        adjustment: 1,
      },
      { type: "deleteBlock", blockId: "stale-block" },
      { type: "duplicateBlock", blockId: "stale-block" },
    ] satisfies PanelCommand[];

    act(() => {
      for (const command of staleCommands) {
        state.panelCommandHandler?.(command);
      }
    });

    expect(state.actions.updateSelectedBlock).not.toHaveBeenCalled();
    expect(state.actions.adjustSelectedBlockFontSize).not.toHaveBeenCalled();
    expect(state.actions.deleteSelectedBlock).not.toHaveBeenCalled();
    expect(state.actions.duplicateSelectedBlock).not.toHaveBeenCalled();
  });

  it("still applies block commands that target the current selection", () => {
    renderHook(() => useAppSessionModel());

    act(() => {
      state.panelCommandHandler?.({
        type: "updateBlock",
        blockId: "current-block",
        patch: { translatedText: "current update" },
      });
      state.panelCommandHandler?.({
        type: "adjustFontSize",
        blockId: "current-block",
        adjustment: -1,
      });
      state.panelCommandHandler?.({
        type: "deleteBlock",
        blockId: "current-block",
      });
      state.panelCommandHandler?.({
        type: "duplicateBlock",
        blockId: "current-block",
      });
    });

    expect(state.actions.updateSelectedBlock).toHaveBeenCalledWith({
      translatedText: "current update",
    });
    expect(state.actions.adjustSelectedBlockFontSize).toHaveBeenCalledWith(-1);
    expect(state.actions.deleteSelectedBlock).toHaveBeenCalledOnce();
    expect(state.actions.duplicateSelectedBlock).toHaveBeenCalledOnce();
  });
});
