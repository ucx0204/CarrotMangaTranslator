// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  PanelSessionContext,
  type PanelSessionValue,
  usePanelSession,
} from "../src/renderer/src/panels/panelSession";
import { useStablePanelSessionValue } from "../src/renderer/src/panels/useStablePanelSessionValue";
import {
  isAppModalSubtreeActive,
  isFloatingOverlaySubtreeActive,
  memoWhileInactive,
} from "../src/renderer/src/app/session/sessionRenderBoundaries";

afterEach(cleanup);

describe("AppSessionView render boundaries", () => {
  it("does not republish equivalent panel data and invokes the latest callback", () => {
    const onCommit = vi.fn();
    const onRender = vi.fn();
    const firstUpdate = vi.fn();
    const latestUpdate = vi.fn();
    const firstRemoveBubbleLayout = vi.fn();
    const latestRemoveBubbleLayout = vi.fn();
    const { rerender } = render(
      <PanelSessionHarness
        onCommit={onCommit}
        onRender={onRender}
        rootRevision={0}
        value={makePanelSessionValue({
          onRemoveBubbleLayout: firstRemoveBubbleLayout,
          onUpdateBlock: firstUpdate,
        })}
      />,
    );

    expect(onRender).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledOnce();

    rerender(
      <PanelSessionHarness
        onCommit={onCommit}
        onRender={onRender}
        rootRevision={1}
        value={makePanelSessionValue({
          onUpdateBlock: latestUpdate,
          onRemoveBubbleLayout: latestRemoveBubbleLayout,
          selectedPageSize: { width: 1200, height: 1800 },
        })}
      />,
    );

    expect(screen.getByTestId("root-revision").textContent).toBe("1");
    expect(onRender).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByTestId("panel-consumer"));

    expect(firstUpdate).not.toHaveBeenCalled();
    expect(latestUpdate).toHaveBeenCalledWith({
      translatedText: "latest callback",
    });
    expect(firstRemoveBubbleLayout).not.toHaveBeenCalled();
    expect(latestRemoveBubbleLayout).toHaveBeenCalledOnce();
  });

  it("publishes selected data, disabled, and page-size changes immediately", () => {
    const onCommit = vi.fn();
    const onRender = vi.fn();
    const { rerender } = render(
      <PanelSessionHarness
        onCommit={onCommit}
        onRender={onRender}
        rootRevision={0}
        value={makePanelSessionValue()}
      />,
    );

    rerender(
      <PanelSessionHarness
        onCommit={onCommit}
        onRender={onRender}
        rootRevision={1}
        value={makePanelSessionValue({ editorDisabled: true })}
      />,
    );
    expect(onRender).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("panel-consumer").textContent).toBe(
      "true:1200:none",
    );

    rerender(
      <PanelSessionHarness
        onCommit={onCommit}
        onRender={onRender}
        rootRevision={2}
        value={makePanelSessionValue({
          editorDisabled: true,
          selectedPageSize: { width: 1600, height: 2400 },
        })}
      />,
    );
    expect(onRender).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("panel-consumer").textContent).toBe(
      "true:1600:none",
    );

    rerender(
      <PanelSessionHarness
        onCommit={onCommit}
        onRender={onRender}
        rootRevision={3}
        value={makePanelSessionValue({
          editorDisabled: true,
          selectedBlock: makeBlock("selected-block"),
          selectedPageSize: { width: 1600, height: 2400 },
        })}
      />,
    );
    expect(onRender).toHaveBeenCalledTimes(4);
    expect(onCommit).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId("panel-consumer").textContent).toBe(
      "true:1600:selected-block",
    );
  });

  it("keeps inactive subtrees asleep and renders every active update", () => {
    const onCommit = vi.fn();
    const onRender = vi.fn();
    const { rerender } = render(
      <MemoizedActivityProbe
        active={false}
        label="closed-0"
        onCommit={onCommit}
        onRender={onRender}
      />,
    );

    rerender(
      <MemoizedActivityProbe
        active={false}
        label="closed-1"
        onCommit={onCommit}
        onRender={onRender}
      />,
    );
    expect(onRender).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledOnce();

    rerender(
      <MemoizedActivityProbe
        active
        label="open-1"
        onCommit={onCommit}
        onRender={onRender}
      />,
    );
    rerender(
      <MemoizedActivityProbe
        active
        label="open-2"
        onCommit={onCommit}
        onRender={onRender}
      />,
    );
    expect(onRender).toHaveBeenCalledTimes(3);
    expect(onCommit).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("activity-probe").textContent).toBe("open-2");

    rerender(
      <MemoizedActivityProbe
        active={false}
        label="closed-2"
        onCommit={onCommit}
        onRender={onRender}
      />,
    );
    rerender(
      <MemoizedActivityProbe
        active={false}
        label="closed-3"
        onCommit={onCommit}
        onRender={onRender}
      />,
    );
    expect(onRender).toHaveBeenCalledTimes(4);
    expect(onCommit).toHaveBeenCalledTimes(4);
  });

  it("recognizes the modal and floating-overlay visibility states", () => {
    expect(isAppModalSubtreeActive(closedAppModalState())).toBe(false);
    expect(
      isAppModalSubtreeActive({
        ...closedAppModalState(),
        settingsOpen: true,
      }),
    ).toBe(true);

    expect(isFloatingOverlaySubtreeActive(closedFloatingOverlayState())).toBe(
      false,
    );
    expect(
      isFloatingOverlaySubtreeActive({
        ...closedFloatingOverlayState(),
        commandPaletteProps: { open: true },
      }),
    ).toBe(true);
  });
});

function PanelSessionHarness({
  onCommit,
  onRender,
  rootRevision,
  value,
}: {
  onCommit: () => void;
  onRender: () => void;
  rootRevision: number;
  value: PanelSessionValue;
}): React.JSX.Element {
  const stableValue = useStablePanelSessionValue(value);
  return (
    <PanelSessionContext.Provider value={stableValue}>
      <PanelSessionProbe onCommit={onCommit} onRender={onRender} />
      <span data-testid="root-revision">{rootRevision}</span>
    </PanelSessionContext.Provider>
  );
}

const PanelSessionProbe = React.memo(function PanelSessionProbe({
  onCommit,
  onRender,
}: {
  onCommit: () => void;
  onRender: () => void;
}): React.JSX.Element {
  const session = usePanelSession();
  onRender();
  return (
    <React.Profiler id="panel-consumer" onRender={onCommit}>
      <button
        type="button"
        data-testid="panel-consumer"
        onClick={() => {
          session.onUpdateBlock({ translatedText: "latest callback" });
          session.onRemoveBubbleLayout();
        }}
      >
        {`${session.editorDisabled}:${session.selectedPageSize?.width ?? 0}:${
          session.selectedBlock?.id ?? "none"
        }`}
      </button>
    </React.Profiler>
  );
});

const MemoizedActivityProbe = memoWhileInactive(
  ActivityProbe,
  (props) => props.active,
);

function ActivityProbe({
  label,
  onCommit,
  onRender,
}: {
  active: boolean;
  label: string;
  onCommit: () => void;
  onRender: () => void;
}): React.JSX.Element {
  onRender();
  return (
    <React.Profiler id="activity-probe" onRender={onCommit}>
      <span data-testid="activity-probe">{label}</span>
    </React.Profiler>
  );
}

function makePanelSessionValue(
  overrides: Partial<PanelSessionValue> = {},
): PanelSessionValue {
  return {
    areaTranslateAvailable: true,
    areaTranslateSelecting: false,
    disableChapterApply: false,
    editorDisabled: false,
    editorFloating: false,
    editorPoppedOut: false,
    onAdjustFontSize: vi.fn(),
    onApplyBlockBackgroundOpacity: vi.fn(),
    onApplyFormat: vi.fn(),
    onDeleteBlock: vi.fn(),
    onDockEditorWindow: vi.fn(),
    onDuplicateBlock: vi.fn(),
    onEraseBlockOriginal: vi.fn(),
    onFitBlockBubble: vi.fn(),
    onPopOutEditor: vi.fn(),
    onRemoveBubbleLayout: vi.fn(),
    onSelectTransformMode: vi.fn(),
    onStartAreaTranslate: vi.fn(),
    onToggleEditorFloat: vi.fn(),
    onUpdateBlock: vi.fn(),
    selectedBlock: null,
    selectedBlockCount: 0,
    selectedPageSize: { width: 1200, height: 1800 },
    showDetachControls: true,
    transformMode: "select",
    ...overrides,
  };
}

function makeBlock(id: string): TranslationBlock {
  return {
    backgroundColor: "transparent",
    bbox: { h: 120, w: 200, x: 40, y: 50 },
    confidence: 1,
    fontSizePx: 32,
    id,
    lineHeight: 1.2,
    opacity: 1,
    renderDirection: "horizontal",
    sourceDirection: "horizontal",
    sourceText: "source",
    textAlign: "center",
    textColor: "#ffffff",
    translatedText: "translated",
    type: "nonsolid",
  };
}

function closedAppModalState() {
  return {
    confirmDialog: null,
    importPreview: null,
    inpaintingGuideOpen: false,
    renameTarget: null,
    settingsOpen: false,
    shareExportOpen: false,
    shareImportPreview: null,
    translationSourceOpen: false,
  };
}

function closedFloatingOverlayState() {
  return {
    autoInpaintingOptionsProps: null,
    commandPaletteProps: { open: false },
    exportOptionsProps: null,
    gatherTextProps: null,
    pageRetranslateProps: null,
    shortcutHelpProps: { open: false },
    styleGuideProps: null,
    translationOptionsProps: null,
  };
}
