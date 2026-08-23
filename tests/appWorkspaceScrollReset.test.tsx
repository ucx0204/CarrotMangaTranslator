// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import { AppWorkspace } from "../src/renderer/src/components/AppWorkspace";
import {
  FontsContext,
  type FontsContextValue,
} from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import {
  isRetouchTool,
  type RetouchTool,
  type WorkspaceTool,
} from "../src/renderer/src/lib/stageTool";
import {
  createWorkspaceInteractionPreviewStore,
  type WorkspaceInteractionPreviewStore,
} from "../src/renderer/src/lib/workspaceInteractionPreview";
import { createBubbleLayoutDraft } from "../src/renderer/src/lib/bubbleLayoutDraft";

const PAGE_1_IMAGE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const PAGE_2_IMAGE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAA/////ywAAAAAAQABAAACAUwAOw==";

beforeEach(() => {
  ResizeObserverStub.reset();
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AppWorkspace scroll reset", () => {
  it("reserves a context row outside the canvas while retaining the workspace scroll ref", () => {
    const refs = makeWorkspaceRefs();
    const page = makePage("page-1");
    const block = makeBlock();
    page.blocks = [block];
    refs.interactionPreviewStore.set({
      bubbleLayoutDraft: createBubbleLayoutDraft(block, page),
    });
    const view = renderWorkspace(
      makeWorkspaceProps({
        refs,
        selectedPage: page,
        selectedPageImageDataUrl: PAGE_1_IMAGE,
        selectedPageImagePageId: "page-1",
      }),
    );

    const shell = view.container.querySelector(".workspace-shell");
    const contextBar = screen.getByRole("region", {
      name: "말풍선 모양 편집",
    });
    const viewport = view.container.querySelector(".workspace-canvas-viewport");
    const workspace = screen.getByLabelText("읽기 영역");
    const stage = view.container.querySelector(".image-stage");

    expect(shell?.firstElementChild).toBe(contextBar);
    expect(shell?.lastElementChild).toBe(viewport);
    expect(viewport?.contains(contextBar)).toBe(false);
    expect(viewport?.contains(workspace)).toBe(true);
    expect(workspace.contains(stage)).toBe(true);
    expect(stage?.contains(contextBar)).toBe(false);
    expect(refs.workspacePanelRef.current).toBe(workspace);
  });

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
    const renderedImage = view.container.querySelector(
      ".page-image",
    ) as HTMLImageElement;
    workspace.scrollTop = 600;
    workspace.scrollLeft = 320;
    const pendingPage = makePage("page-2");
    pendingPage.blocks = [makeBlock()];

    view.rerender(
      withFonts(
        <AppWorkspace
          {...makeWorkspaceProps({
            refs,
            selectedPage: pendingPage,
            selectedPageImageDataUrl: PAGE_1_IMAGE,
            selectedPageImageLoading: true,
            selectedPageImagePageId: null,
          })}
          showTextBlocks
          stageSize={{ height: 800, width: 500 }}
        />,
      ),
    );

    expect(workspace.scrollTop).toBe(600);
    expect(workspace.scrollLeft).toBe(320);
    expect(
      screen.getByRole("status", { name: "이미지 불러오는 중" }),
    ).not.toBeNull();
    expect(
      (view.container.querySelector(".page-image") as HTMLImageElement).src,
    ).toBe(PAGE_1_IMAGE);
    expect(view.container.querySelector(".page-image")).toBe(renderedImage);
    expect(view.container.querySelector(".overlay-block")).toBeNull();

    view.rerender(
      withFonts(
        <AppWorkspace
          {...makeWorkspaceProps({
            refs,
            selectedPage: pendingPage,
            selectedPageImageDataUrl: PAGE_2_IMAGE,
            selectedPageImageLoading: false,
            selectedPageImagePageId: "page-2",
          })}
          showTextBlocks
          stageSize={{ height: 800, width: 500 }}
        />,
      ),
    );

    expect(workspace.scrollTop).toBe(0);
    expect(workspace.scrollLeft).toBe(0);
    expect(screen.queryByRole("status")).toBeNull();
    expect(view.container.querySelector(".page-image")).toBe(renderedImage);
    expect(view.container.querySelector(".overlay-block")).not.toBeNull();
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

  it("recomputes fit scrolling after layout and follows a changed scroll origin", () => {
    const refs = makeWorkspaceRefs();
    const onEffectiveScaleChange = vi.fn();
    const narrowPage = {
      ...makePage("page-1"),
      width: 100,
      height: 1600,
    };
    const props = {
      ...makeWorkspaceProps({
        refs,
        selectedPage: narrowPage,
        selectedPageImageDataUrl: PAGE_1_IMAGE,
        selectedPageImagePageId: "page-1",
      }),
      onEffectiveScaleChange,
      workspaceFitMode: "actual" as const,
    };
    const view = renderWorkspace(props);
    const workspace = screen.getByLabelText("읽기 영역") as HTMLElement;
    Object.defineProperties(workspace, {
      clientHeight: { configurable: true, value: 500 },
      clientWidth: { configurable: true, value: 400 },
    });

    act(() => ResizeObserverStub.emit());

    expect(onEffectiveScaleChange).toHaveBeenLastCalledWith(1);
    expect(workspace.classList.contains("is-fit-scroll-locked")).toBe(false);
    expect(workspace.scrollLeft).toBe(50);
    expect(workspace.scrollTop).toBe(250);

    view.rerender(withFonts(<AppWorkspace {...props} workspaceZoom={2} />));

    expect(onEffectiveScaleChange).toHaveBeenLastCalledWith(2);
    expect(workspace.scrollLeft).toBe(100);
    expect(workspace.scrollTop).toBe(250);

    view.rerender(
      withFonts(
        <AppWorkspace
          {...props}
          selectedPage={null}
          selectedPageImagePageId={null}
        />,
      ),
    );
    expect(view.container.querySelector(".stage-toolbar")).toBeNull();
  });

  it("does not overwrite an anchored camera when a later layout pass changes the origin", () => {
    const refs = makeWorkspaceRefs();
    const props = {
      ...makeWorkspaceProps({
        refs,
        selectedPage: { ...makePage("page-1"), width: 1000, height: 1000 },
        selectedPageImageDataUrl: PAGE_1_IMAGE,
        selectedPageImagePageId: "page-1",
      }),
      workspaceFitMode: "actual" as const,
      workspaceZoom: 2,
    };
    renderWorkspace(props);
    const workspace = screen.getByLabelText("읽기 영역") as HTMLElement;
    let clientWidth = 400;
    let clientHeight = 500;
    Object.defineProperties(workspace, {
      clientHeight: { configurable: true, get: () => clientHeight },
      clientWidth: { configurable: true, get: () => clientWidth },
    });

    act(() => ResizeObserverStub.emit());
    expect(workspace.scrollLeft).toBe(200);
    expect(workspace.scrollTop).toBe(250);

    // Simulate the selection/cursor anchor restoring a deliberate camera.
    workspace.scrollLeft = 733;
    workspace.scrollTop = 644;
    clientWidth = 380;
    clientHeight = 480;
    act(() => ResizeObserverStub.emit());

    expect(workspace.scrollLeft).toBe(733);
    expect(workspace.scrollTop).toBe(644);
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

  it("keeps the painted page image mounted across mask and retouch tool switches", () => {
    const refs = makeWorkspaceRefs();
    const props = {
      ...makeWorkspaceProps({
        refs,
        selectedPage: makePage("page-1"),
        selectedPageImageDataUrl: PAGE_1_IMAGE,
        selectedPageImagePageId: "page-1",
      }),
      stageSize: { height: 800, width: 500 },
    };
    render(withFonts(<WorkspaceToolTransitionHarness props={props} />));
    const pageImage = screen.getByRole("img", {
      name: "page-1.png",
    }) as HTMLImageElement;
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) =>
      mutations.push(...records),
    );
    observer.observe(pageImage.parentElement as HTMLElement, {
      attributeFilter: ["src"],
      attributes: true,
      childList: true,
      subtree: true,
    });

    for (const label of ["마스크", "브러시", "지우개", "선택"]) {
      if (label === "선택" || label === "마스크") {
        fireEvent.click(screen.getByRole("button", { name: label }));
      } else {
        const groupId = label === "브러시" ? "paint" : "restore";
        const retouchTrigger = document.querySelector<HTMLButtonElement>(
          `[data-stage-tool-group="${groupId}"]`,
        );
        expect(retouchTrigger).toBeDefined();
        fireEvent.click(retouchTrigger as HTMLButtonElement);
        const retouchMenu = document.querySelector<HTMLElement>(
          `[data-stage-tool-menu="${groupId}"]`,
        );
        expect(retouchMenu).not.toBeNull();
        fireEvent.click(
          within(retouchMenu as HTMLElement).getByRole("menuitemradio", {
            name: label,
          }),
        );
      }
      expect(screen.getByRole("img", { name: "page-1.png" })).toBe(pageImage);
      expect(pageImage.isConnected).toBe(true);
      expect(pageImage.src).toBe(PAGE_1_IMAGE);
      expect(document.querySelector(".page-image-placeholder")).toBeNull();
      if (label !== "선택") {
        const liveCanvas = document.querySelector<HTMLCanvasElement>(
          "[data-retouch-live-canvas]",
        );
        expect(liveCanvas?.width).toBe(500);
        expect(liveCanvas?.height).toBe(800);
      }
      mutations.push(...observer.takeRecords());
    }
    observer.disconnect();

    expect(
      mutations.some(
        (mutation) =>
          (mutation.type === "attributes" && mutation.target === pageImage) ||
          Array.from(mutation.removedNodes).some(
            (node) =>
              node === pageImage ||
              (node instanceof Element && node.contains(pageImage)),
          ),
      ),
    ).toBe(false);
  });

  it("blends the original between the inpainted page and editing overlays", () => {
    const refs = makeWorkspaceRefs();
    const page = makePage("page-1");
    page.blocks = [makeBlock()];
    const props = {
      ...makeWorkspaceProps({
        refs,
        selectedPage: page,
        selectedPageImageDataUrl: PAGE_1_IMAGE,
        selectedPageImagePageId: "page-1",
      }),
      originalImageOpacity: 0.37,
      originalImageOpacityAvailable: true,
      retouchOriginalImageDataUrl: PAGE_2_IMAGE,
      showBlockChrome: true,
      showTextBlocks: true,
      stageSize: { height: 800, width: 500 },
    };
    const view = renderWorkspace(props);
    const pageImage = view.container.querySelector(".page-image");
    const originalLayer = view.container.querySelector(
      "[data-original-image-opacity-layer]",
    ) as HTMLImageElement | null;
    const blockLayer = view.container.querySelector(".overlay-block");

    expect(originalLayer?.src).toBe(PAGE_2_IMAGE);
    expect(originalLayer?.style.opacity).toBe("0.37");
    expect(pageImage?.compareDocumentPosition(originalLayer as Node) ?? 0).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      originalLayer?.compareDocumentPosition(blockLayer as Node) ?? 0,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    view.rerender(
      withFonts(<AppWorkspace {...props} originalImageOpacity={0} />),
    );
    expect(
      view.container.querySelector("[data-original-image-opacity-layer]"),
    ).toBeNull();

    view.rerender(
      withFonts(<AppWorkspace {...props} showingOriginalPeek={true} />),
    );
    expect(
      view.container.querySelector("[data-original-image-opacity-layer]"),
    ).toBeNull();
    expect(view.container.querySelector(".peek-original-badge")).toBeNull();
  });

  it("shows only the original and disables stage editing while comparing", () => {
    const refs = makeWorkspaceRefs();
    const page = makePage("page-1");
    page.blocks = [makeBlock()];
    const onStagePointerDown = vi.fn();
    const onStagePointerLeave = vi.fn();
    const onStagePointerMove = vi.fn();
    const onStagePointerUp = vi.fn();
    const props = {
      ...makeWorkspaceProps({
        refs,
        selectedPage: page,
        selectedPageImageDataUrl: PAGE_1_IMAGE,
        selectedPageImagePageId: "page-1",
      }),
      maskStrokes: [
        {
          points: [
            { x: 10, y: 20 },
            { x: 30, y: 40 },
          ],
          radiusPx: 12,
        },
      ],
      onStagePointerDown,
      onStagePointerLeave,
      onStagePointerMove,
      onStagePointerUp,
      regionSelectionActive: true,
      regionSelectionRect: { x: 10, y: 20, w: 100, h: 80 },
      retouchCursor: {
        color: "#ffffff",
        mode: "brush" as const,
        radiusPx: 28,
      },
      showBlockChrome: true,
      showTextBlocks: true,
      stageSize: { height: 800, width: 500 },
    };
    const view = renderWorkspace(props);

    expect(
      view.container.querySelector(".overlay-text-content")?.textContent,
    ).toContain("translated text");
    expect(view.container.querySelector(".overlay-block")).not.toBeNull();
    expect(
      view.container.querySelector(".retouch-preview-committed-mask"),
    ).not.toBeNull();
    expect(
      view.container.querySelector("[data-retouch-live-cursor]"),
    ).not.toBeNull();
    expect(
      view.container.querySelector(".region-selection-box"),
    ).not.toBeNull();

    view.rerender(
      withFonts(<AppWorkspace {...props} showingOriginalPeek={true} />),
    );
    expect(screen.queryByText("translated text")).toBeNull();
    expect(view.container.querySelector(".overlay-block")).toBeNull();
    expect(
      view.container.querySelector(".retouch-preview-committed-mask"),
    ).toBeNull();
    expect(
      view.container.querySelector("[data-retouch-live-cursor]"),
    ).toBeNull();
    expect(view.container.querySelector(".region-selection-box")).toBeNull();

    const stage = view.container.querySelector(".image-stage");
    expect(stage).not.toBeNull();
    fireEvent.pointerDown(stage as Element);
    fireEvent.pointerMove(stage as Element);
    fireEvent.pointerUp(stage as Element);
    fireEvent.pointerLeave(stage as Element);
    expect(onStagePointerDown).not.toHaveBeenCalled();
    expect(onStagePointerMove).not.toHaveBeenCalled();
    expect(onStagePointerUp).not.toHaveBeenCalled();
    expect(onStagePointerLeave).not.toHaveBeenCalled();

    view.rerender(
      withFonts(<AppWorkspace {...props} showingOriginalPeek={false} />),
    );
    expect(
      view.container.querySelector(".overlay-text-content")?.textContent,
    ).toContain("translated text");
    expect(view.container.querySelector(".overlay-block")).not.toBeNull();
    expect(
      view.container.querySelector(".retouch-preview-committed-mask"),
    ).not.toBeNull();
    expect(
      view.container.querySelector("[data-retouch-live-cursor]"),
    ).not.toBeNull();
    expect(
      view.container.querySelector(".region-selection-box"),
    ).not.toBeNull();
  });

  it("focuses the workspace before a child pointer handler prevents default", () => {
    const refs = makeWorkspaceRefs();
    const props = makeWorkspaceProps({
      refs,
      selectedPage: makePage("page-1"),
      selectedPageImageDataUrl: PAGE_1_IMAGE,
      selectedPageImagePageId: "page-1",
    });
    props.onStagePointerDown = (event) => event.preventDefault();
    const view = renderWorkspace(props);
    const workspace = screen.getByLabelText("읽기 영역");
    const stage = view.container.querySelector(".image-stage");
    expect(stage).not.toBeNull();

    fireEvent.pointerDown(stage as Element);

    expect(document.activeElement).toBe(workspace);
  });
});

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this);
  }

  static emit(): void {
    for (const instance of ResizeObserverStub.instances) {
      instance.callback([], instance);
    }
  }

  static reset(): void {
    ResizeObserverStub.instances = [];
  }

  observe(): void {
    return undefined;
  }

  disconnect(): void {
    return undefined;
  }

  unobserve(): void {
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

function WorkspaceToolTransitionHarness({
  props,
}: {
  props: AppWorkspaceProps;
}): React.JSX.Element {
  const [tool, setTool] = React.useState<WorkspaceTool>("select");
  const [lastRetouchTool, setLastRetouchTool] =
    React.useState<RetouchTool>("brush");
  const selectTool = (nextTool: WorkspaceTool): void => {
    setTool(nextTool);
    if (isRetouchTool(nextTool)) {
      setLastRetouchTool(nextTool);
    }
  };
  const retouchCursor =
    tool === "mask" || tool === "brush" || tool === "eraser"
      ? { color: "#ffffff", mode: tool, radiusPx: 28 }
      : null;
  return (
    <AppWorkspace
      {...props}
      lastRetouchTool={lastRetouchTool}
      onSelectStageTool={selectTool}
      retouchCursor={retouchCursor}
      stageTool={tool}
    />
  );
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
  selectedPageImageLoading = false,
  selectedPageImagePageId,
}: {
  refs: WorkspaceRefs;
  selectedPage: MangaPage;
  selectedPageImageDataUrl: string;
  selectedPageImageLoading?: boolean;
  selectedPageImagePageId: string | null;
}): AppWorkspaceProps {
  return {
    brushColor: "#ffffff",
    imageRef: refs.imageRef,
    interactionPreviewStore: refs.interactionPreviewStore,
    jobActive: false,
    jobState: {
      id: "",
      kind: "gemma-analysis",
      progressText: "",
      status: "idle",
    },
    lastRetouchTool: "brush",
    maskStrokes: [],
    originalImageOpacity: 0,
    originalImageOpacityAvailable: false,
    onApplyBubbleLayoutDraft: () => undefined,
    onBlockPointerDown: () => undefined,
    onCancelBubbleLayoutDraft: () => undefined,
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
    onUndoBubbleLayoutPoint: () => undefined,
    onChangeWorkspaceFitMode: () => undefined,
    onChangeOriginalImageOpacity: () => undefined,
    onChangeWorkspaceZoom: () => undefined,
    onResetWorkspaceZoom: () => undefined,
    onZoomInWorkspace: () => undefined,
    onZoomOutWorkspace: () => undefined,
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
    selectedPageImageLoading,
    selectedPageImagePageId,
    showBlockChrome: false,
    showTextBlocks: false,
    showingOriginalPeek: false,
    stageRef: refs.stageRef,
    stageSize: null,
    stageTool: "select",
    stageToolbarHidden: false,
    workspacePanelRef: refs.workspacePanelRef,
    workspaceZoomControllerRef: React.createRef(),
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

function makeBlock(): MangaPage["blocks"][number] {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 300, h: 160 },
    sourceText: "source text",
    translatedText: "translated text",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "vertical",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#000000",
    backgroundColor: "#ffffff",
    opacity: 1,
    inpaintExcluded: true,
  };
}
