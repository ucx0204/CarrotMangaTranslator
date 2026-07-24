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
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import {
  createWorkspaceInteractionPreviewStore,
  type WorkspaceInteractionPreviewStore,
} from "../src/renderer/src/lib/workspaceInteractionPreview";

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
    workspace.scrollLeft = 320;

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
    expect(workspace.scrollLeft).toBe(320);

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
    expect(workspace.scrollLeft).toBe(0);
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

  it("does not rescan canvas blocks for job-progress-only root updates", () => {
    const refs = makeWorkspaceRefs();
    const page = makePage("page-1");
    let blockCollectionReads = 0;
    page.blocks = new Proxy(page.blocks, {
      get(target, property, receiver) {
        if (property === "filter" || property === "map") {
          blockCollectionReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const props = {
      ...makeWorkspaceProps({
        refs,
        selectedPage: page,
        selectedPageImageDataUrl: PAGE_1_IMAGE,
        selectedPageImagePageId: "page-1",
      }),
      jobActive: true,
      jobState: {
        id: "job-1",
        kind: "gemma-analysis" as const,
        progressText: "1 / 100",
        status: "running" as const,
      },
      stageSize: { height: 800, width: 500 },
    };
    const view = renderWorkspace(props);
    expect(blockCollectionReads).toBeGreaterThan(0);
    blockCollectionReads = 0;

    view.rerender(
      withFonts(
        <AppWorkspace
          {...props}
          jobState={{
            ...props.jobState,
            detail: "2 / 100",
            progressText: "2 / 100",
          }}
        />,
      ),
    );

    expect(blockCollectionReads).toBe(0);
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
  interactionPreviewStore: WorkspaceInteractionPreviewStore;
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
    interactionPreviewStore: createWorkspaceInteractionPreviewStore(),
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
    brushColor: "#ffffff",
    brushRadius: 28,
    canRedo: false,
    canUndo: false,
    imageRef: refs.imageRef,
    interactionPreviewStore: refs.interactionPreviewStore,
    jobActive: false,
    jobState: {
      id: "",
      kind: "gemma-analysis",
      progressText: "",
      status: "idle",
    },
    maskStrokes: [],
    onBlockPointerDown: () => undefined,
    onPeekToggle: () => undefined,
    onRedo: () => undefined,
    onResetPage: () => undefined,
    onOpenBatchImport: () => undefined,
    onOpenSettings: () => undefined,
    onOpenShareImport: () => undefined,
    onOpenTranslationSource: () => undefined,
    onSelectStageTool: () => undefined,
    onStagePointerDown: () => undefined,
    onStagePointerLeave: () => undefined,
    onStagePointerMove: () => undefined,
    onStagePointerUp: () => undefined,
    onToggleRegionTranslation: () => undefined,
    onToggleStageToolbarHidden: () => undefined,
    onChangeWorkspaceFitMode: () => undefined,
    onResetWorkspaceZoom: () => undefined,
    onZoomInWorkspace: () => undefined,
    onZoomOutWorkspace: () => undefined,
    onUndo: () => undefined,
    compareAvailable: false,
    resetAvailable: false,
    progressSnapshot: null,
    regionSelectionActive: false,
    regionTranslationAvailable: true,
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
    workspaceFitMode: "contain",
    workspaceZoom: 1,
  };
}

function makeFontsContext(): FontsContextValue {
  return {
    busy: false,
    catalog: DEFAULT_BLOCK_FONT_CATALOG,
    baseOptions: [],
    options: [],
    registerFont: async () => undefined,
    removeFont: async () => undefined,
    savePreferences: async () => undefined,
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
