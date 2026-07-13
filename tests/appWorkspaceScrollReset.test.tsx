// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import { AppWorkspace } from "../src/renderer/src/components/AppWorkspace";
import {
  FontsContext,
  type FontsContextValue,
} from "../src/renderer/src/fonts/fontsContextValue";

const PAGE_1_IMAGE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const PAGE_2_IMAGE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAA/////ywAAAAAAQABAAACAUwAOw==";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AppWorkspace scroll reset", () => {
  it("waits until the selected page image is actually rendered before resetting scroll", () => {
    const refs = makeWorkspaceRefs();
    const view = renderWorkspace(
      makeWorkspaceProps({
        refs,
        selectedPage: makePage("page-1"),
        selectedPageImageDataUrl: PAGE_1_IMAGE,
        selectedPageImagePageId: "page-1",
      }),
    );
    const workspace = screen.getByLabelText("읽기 영역") as HTMLElement;
    workspace.scrollTop = 600;

    view.rerender(
      withFonts(
        <AppWorkspace
          {...makeWorkspaceProps({
            refs,
            selectedPage: makePage("page-2"),
            selectedPageImageDataUrl: PAGE_1_IMAGE,
            selectedPageImagePageId: "page-1",
          })}
        />,
      ),
    );

    expect(workspace.scrollTop).toBe(600);

    view.rerender(
      withFonts(
        <AppWorkspace
          {...makeWorkspaceProps({
            refs,
            selectedPage: makePage("page-2"),
            selectedPageImageDataUrl: PAGE_2_IMAGE,
            selectedPageImagePageId: "page-2",
          })}
        />,
      ),
    );

    expect(workspace.scrollTop).toBe(0);
  });

  it("does not keep forcing scroll to top while the same page remains rendered", () => {
    const refs = makeWorkspaceRefs();
    const view = renderWorkspace(
      makeWorkspaceProps({
        refs,
        selectedPage: makePage("page-1"),
        selectedPageImageDataUrl: PAGE_1_IMAGE,
        selectedPageImagePageId: "page-1",
      }),
    );
    const workspace = screen.getByLabelText("읽기 영역") as HTMLElement;
    workspace.scrollTop = 400;

    view.rerender(
      withFonts(
        <AppWorkspace
          {...makeWorkspaceProps({
            refs,
            selectedPage: makePage("page-1"),
            selectedPageImageDataUrl: PAGE_2_IMAGE,
            selectedPageImagePageId: "page-1",
          })}
        />,
      ),
    );

    expect(workspace.scrollTop).toBe(400);
  });
});

class ResizeObserverStub {
  observe(): void {
    return undefined;
  }

  disconnect(): void {
    return undefined;
  }
}

type AppWorkspaceProps = React.ComponentProps<typeof AppWorkspace>;

type WorkspaceRefs = {
  imageRef: React.RefObject<HTMLImageElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  workspacePanelRef: React.RefObject<HTMLElement | null>;
};

function renderWorkspace(props: AppWorkspaceProps) {
  return render(withFonts(<AppWorkspace {...props} />));
}

function withFonts(node: React.ReactElement): React.JSX.Element {
  return (
    <FontsContext.Provider value={makeFontsContext()}>
      {node}
    </FontsContext.Provider>
  );
}

function makeWorkspaceRefs(): WorkspaceRefs {
  return {
    imageRef: React.createRef<HTMLImageElement | null>(),
    stageRef: React.createRef<HTMLDivElement | null>(),
    workspacePanelRef: React.createRef<HTMLElement | null>(),
  };
}

function makeWorkspaceProps({
  refs,
  selectedPage,
  selectedPageImageDataUrl,
  selectedPageImagePageId,
}: {
  refs: WorkspaceRefs;
  selectedPage: MangaPage;
  selectedPageImageDataUrl: string;
  selectedPageImagePageId: string | null;
}): AppWorkspaceProps {
  return {
    autoInpaintingOpen: false,
    blockCreateRect: null,
    brushColor: "#ffffff",
    brushRadius: 28,
    dragHud: null,
    imageRef: refs.imageRef,
    jobActive: false,
    jobState: {
      id: "",
      kind: "gemma-analysis",
      progressText: "",
      status: "idle",
    },
    maskStrokes: [],
    onBlockPointerDown: () => undefined,
    onOpenBatchImport: () => undefined,
    onOpenSettings: () => undefined,
    onOpenShareImport: () => undefined,
    onOpenTranslationSource: () => undefined,
    onSelectStageTool: () => undefined,
    onStagePointerDown: () => undefined,
    onStagePointerLeave: () => undefined,
    onStagePointerMove: () => undefined,
    onStagePointerUp: () => undefined,
    onToggleBlockExcluded: () => undefined,
    onToggleStageToolbarHidden: () => undefined,
    progressSnapshot: null,
    regionSelectionActive: false,
    regionSelectionRect: null,
    retouchCursor: null,
    retouchOriginalImageDataUrl: "",
    selectedBlockId: null,
    selectedBlockIds: [],
    selectedPage,
    selectedPageImageDataUrl,
    selectedPageImagePageId,
    showBlockChrome: false,
    showTextBlocks: false,
    showingOriginalPeek: false,
    stageRef: refs.stageRef,
    stageSize: null,
    stageTool: "select",
    stageToolbarHidden: false,
    workspacePanelRef: refs.workspacePanelRef,
    workspaceZoom: 1,
  };
}

function makeFontsContext(): FontsContextValue {
  return {
    busy: false,
    customFonts: [],
    options: [],
    registerFont: async () => undefined,
    removeFont: async () => undefined,
  };
}

function makePage(id: string): MangaPage {
  return {
    id,
    name: `${id}.png`,
    imagePath: `${id}.png`,
    dataUrl: "",
    width: 1000,
    height: 1600,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
