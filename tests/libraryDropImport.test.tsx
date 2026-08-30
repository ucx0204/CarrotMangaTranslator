/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { LibraryDropOverlay } from "../src/renderer/src/components/LibraryDropOverlay";
import { useLibraryDropImport } from "../src/renderer/src/hooks/useLibraryDropImport";
import { dismissToast, getToasts } from "../src/renderer/src/lib/toastStore";
import type { ImportPreviewSession } from "../src/shared/importTypes";

afterEach(() => {
  cleanup();
  getToasts().forEach((item) => dismissToast(item.id));
});

describe("global library file drop", () => {
  it("opens the existing import preview for dropped images", async () => {
    const preview = makePreview();
    const getPathForFile = vi.fn((file: File) => `C:\\drop\\${file.name}`);
    const previewDroppedImport = vi.fn(async () => ({
      status: "ready" as const,
      preview,
    }));
    window.mangaApi = createTestMangaGatewayStub({
      getPathForFile,
      previewDroppedImport,
    });
    const setImportPreview = vi.fn();
    const setTranslationSourceOpen = vi.fn();
    const view = renderDropHook({
      setImportPreview,
      setTranslationSourceOpen,
    });
    const file = new File(["image"], "001.png", { type: "image/png" });

    act(() => {
      window.dispatchEvent(makeDragEvent("dragenter", [file]));
    });
    expect(view.result.current).toMatchObject({
      active: true,
      blocked: false,
    });

    const dropEvent = makeDragEvent("drop", [file]);
    act(() => {
      window.dispatchEvent(dropEvent);
    });

    expect(dropEvent.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(setImportPreview).toHaveBeenCalledWith(preview);
    });
    expect(getPathForFile).toHaveBeenCalledWith(file);
    expect(previewDroppedImport).toHaveBeenCalledWith(["C:\\drop\\001.png"]);
    expect(setTranslationSourceOpen).toHaveBeenCalledWith(false);
    expect(view.result.current.active).toBe(false);
  });

  it("blocks a drop while another modal or operation is active", () => {
    const previewDroppedImport = vi.fn();
    window.mangaApi = createTestMangaGatewayStub({
      getPathForFile: vi.fn(() => "C:\\drop\\001.png"),
      previewDroppedImport,
    });
    const view = renderDropHook({ blocked: true });
    const file = new File(["image"], "001.png", { type: "image/png" });

    act(() => {
      window.dispatchEvent(makeDragEvent("dragenter", [file]));
    });
    expect(view.result.current).toMatchObject({ active: true, blocked: true });
    const dragOverEvent = makeDragEvent("dragover", [file]);
    act(() => {
      window.dispatchEvent(dragOverEvent);
    });
    expect(dragOverEvent.dataTransfer?.dropEffect).toBe("none");

    act(() => {
      window.dispatchEvent(makeDragEvent("drop", [file]));
    });

    expect(previewDroppedImport).not.toHaveBeenCalled();
    expect(getToasts().at(0)).toMatchObject({
      variant: "info",
      message: "다른 창이나 작업이 열려 있습니다. 끝낸 뒤 다시 놓아 주세요.",
    });
  });

  it("keeps the current source modal open and warns for an invalid mix", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      getPathForFile: vi.fn((file: File) => `C:\\drop\\${file.name}`),
      previewDroppedImport: vi.fn(async () => ({
        status: "rejected" as const,
        reason: "unsupported-files" as const,
        names: ["notes.txt"],
        count: 1,
      })),
    });
    const setImportPreview = vi.fn();
    const setTranslationSourceOpen = vi.fn();
    renderDropHook({ setImportPreview, setTranslationSourceOpen });
    const image = new File(["image"], "001.png", { type: "image/png" });
    const notes = new File(["notes"], "notes.txt", { type: "text/plain" });

    act(() => {
      window.dispatchEvent(makeDragEvent("drop", [image, notes]));
    });

    await waitFor(() => {
      expect(getToasts().at(0)).toMatchObject({
        variant: "warn",
        message: expect.stringContaining("notes.txt"),
      });
    });
    expect(setTranslationSourceOpen).not.toHaveBeenCalled();
    expect(setImportPreview).not.toHaveBeenCalled();
  });

  it("silently stops when background preparation was cancelled", async () => {
    const previewDroppedImport = vi.fn(async () => ({
      status: "rejected" as const,
      reason: "cancelled" as const,
    }));
    window.mangaApi = createTestMangaGatewayStub({
      getPathForFile: vi.fn(() => "C:\\drop\\001.pdf"),
      previewDroppedImport,
    });
    const view = renderDropHook();

    act(() => {
      window.dispatchEvent(
        makeDragEvent("drop", [new File(["pdf"], "001.pdf")]),
      );
    });

    await waitFor(() => expect(previewDroppedImport).toHaveBeenCalledOnce());
    await waitFor(() => expect(view.result.current.busy).toBe(false));
    expect(getToasts()).toEqual([]);
  });

  it("reports a main-process busy rejection as informational feedback", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      getPathForFile: vi.fn(() => "C:\\drop\\001.png"),
      previewDroppedImport: vi.fn(async () => ({
        status: "rejected" as const,
        reason: "busy" as const,
      })),
    });
    renderDropHook();

    act(() => {
      window.dispatchEvent(
        makeDragEvent("drop", [new File(["image"], "001.png")]),
      );
    });

    await waitFor(() => {
      expect(getToasts().at(0)).toMatchObject({
        variant: "info",
        message: "다른 창이나 작업이 열려 있습니다. 끝낸 뒤 다시 놓아 주세요.",
      });
    });
  });

  it("rejects an oversized drop before resolving any native paths", () => {
    const getPathForFile = vi.fn();
    const previewDroppedImport = vi.fn();
    window.mangaApi = createTestMangaGatewayStub({
      getPathForFile,
      previewDroppedImport,
    });
    renderDropHook();
    const file = new File(["image"], "001.png");

    act(() => {
      window.dispatchEvent(
        makeDragEvent(
          "drop",
          Array.from({ length: 2001 }, () => file),
        ),
      );
    });

    expect(getPathForFile).not.toHaveBeenCalled();
    expect(previewDroppedImport).not.toHaveBeenCalled();
    expect(getToasts().at(0)).toMatchObject({
      variant: "warn",
      message: "한 번에 2000개까지만 추가할 수 있습니다.",
    });
  });

  it("ignores non-file drags and does not prevent their default behavior", () => {
    const previewDroppedImport = vi.fn();
    window.mangaApi = createTestMangaGatewayStub({ previewDroppedImport });
    const view = renderDropHook();
    const dragEvent = makeDragEvent("dragenter", [], ["text/plain"]);

    act(() => {
      window.dispatchEvent(dragEvent);
    });

    expect(dragEvent.defaultPrevented).toBe(false);
    expect(view.result.current.active).toBe(false);
    expect(previewDroppedImport).not.toHaveBeenCalled();
  });

  it("keeps the overlay visible while a nested drag target is still active", () => {
    window.mangaApi = createTestMangaGatewayStub();
    const view = renderDropHook();
    const file = new File(["image"], "001.png");

    act(() => {
      window.dispatchEvent(makeDragEvent("dragenter", [file]));
      window.dispatchEvent(makeDragEvent("dragenter", [file]));
      window.dispatchEvent(makeDragEvent("dragleave", [file]));
    });
    expect(view.result.current.active).toBe(true);

    act(() => {
      window.dispatchEvent(makeDragEvent("dragleave", [file]));
    });
    expect(view.result.current.active).toBe(false);
  });

  it("turns bridge path failures into an error toast and status entry", async () => {
    const pushStatus = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    window.mangaApi = createTestMangaGatewayStub({
      getPathForFile: vi.fn(() => {
        throw new Error("path unavailable");
      }),
      previewDroppedImport: vi.fn(),
    });
    renderDropHook({ pushStatus });

    act(() => {
      window.dispatchEvent(
        makeDragEvent("drop", [new File(["image"], "001.png")]),
      );
    });

    await waitFor(() => {
      expect(getToasts().at(0)).toMatchObject({
        variant: "error",
        message: "놓은 원본을 읽지 못했습니다.",
      });
    });
    expect(pushStatus).toHaveBeenCalledWith("놓은 원본을 읽지 못했습니다.");
    consoleError.mockRestore();
  });
});

describe("library drop overlay", () => {
  it("shows ready and blocked guidance from the production component", () => {
    const view = render(<LibraryDropOverlay active blocked={false} />);

    expect(screen.getByRole("status").classList).toContain("ready");
    expect(screen.getByText("놓아서 보관함에 추가")).not.toBeNull();

    view.rerender(<LibraryDropOverlay active blocked />);
    expect(screen.getByRole("status").classList).toContain("blocked");
    expect(screen.getByText("지금은 추가할 수 없습니다")).not.toBeNull();
  });

  it("does not mount when no file drag is active", () => {
    render(<LibraryDropOverlay active={false} blocked={false} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

function renderDropHook({
  blocked = false,
  pushStatus = vi.fn(),
  setImportPreview = vi.fn(),
  setTranslationSourceOpen = vi.fn(),
}: {
  blocked?: boolean;
  pushStatus?: (line: string) => void;
  setImportPreview?: React.Dispatch<
    React.SetStateAction<ImportPreviewSession | null>
  >;
  setTranslationSourceOpen?: React.Dispatch<React.SetStateAction<boolean>>;
} = {}) {
  return renderHook(() =>
    useLibraryDropImport({
      blocked,
      pushStatus,
      setImportPreview,
      setTranslationSourceOpen,
    }),
  );
}

function makeDragEvent(
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  files: File[],
  types: string[] = ["Files"],
): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, types, dropEffect: "none" },
  });
  Object.defineProperty(event, "relatedTarget", { value: null });
  return event as DragEvent;
}

function makePreview(): ImportPreviewSession {
  return {
    previewId: "11111111-1111-4111-8111-111111111111",
    mode: "single",
    sourceKind: "images",
    suggestedWorkTitle: "Dropped images",
    chapters: [
      {
        draftId: "22222222-2222-4222-8222-222222222222",
        title: "Chapter 1",
        sourceKind: "images",
        pages: [
          {
            name: "001.png",
            sourcePath: "C:\\drop\\001.png",
            sourceKind: "file",
          },
        ],
      },
    ],
  };
}
