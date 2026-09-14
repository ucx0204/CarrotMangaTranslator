/** @vitest-environment jsdom */
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChapterQuickControls } from "../src/renderer/src/components/ChapterQuickControls";
import {
  PageListThumbnail,
  PageStatus,
} from "../src/renderer/src/components/pageList/PageListRowChrome";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { makePage } from "./unifiedInpaintingUiFixtures";
import type { ObservePageThumbnail } from "../src/renderer/src/components/pageThumbnails";

const visible: ObservePageThumbnail = (_element, load) => {
  load();
  return () => {};
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps comparison, display and nonconflicting history usable while protecting page reset", () => {
  const peek = vi.fn();
  const undo = vi.fn();
  const props = {
    canRedo: true,
    canUndo: true,
    chapterAvailable: true,
    compareAvailable: true,
    disabled: true,
    peeking: false,
    resetAvailable: true,
    showBlockChrome: true,
    showTextBlocks: true,
    undoLabel: "B 페이지 붓질",
    redoLabel: "B 페이지 이동",
    onPeekToggle: peek,
    onUndo: undo,
    onOpenStyleGuide: vi.fn(),
    onOpenTextView: vi.fn(),
    onRedo: vi.fn(),
    onResetPage: vi.fn(),
    onToggleBlocks: vi.fn(),
    onToggleChrome: vi.fn(),
  };
  const view = render(<ChapterQuickControls {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "원본과 비교" }));
  fireEvent.click(screen.getByRole("button", { name: /B 페이지 붓질/ }));
  expect(peek).toHaveBeenCalledOnce();
  expect(undo).toHaveBeenCalledOnce();
  expect(
    Array.from(
      view.container.querySelectorAll(
        '[data-chapter-quick-group="original"] button',
      ),
    )
      .at(-1)
      ?.hasAttribute("disabled"),
  ).toBe(true);
  view.rerender(
    <ChapterQuickControls
      {...props}
      peeking
      disabled={false}
      resetAvailable={false}
      canUndo={false}
      canRedo={false}
      chapterAvailable={false}
    />,
  );
  expect(
    screen
      .getByRole("button", { name: "원본 비교 끝내기" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

it("shows the page lock separately and retries a thumbnail decode once", async () => {
  const page = { ...makePage(), dataUrl: "" };
  const load = vi
    .fn()
    .mockResolvedValueOnce("first-url")
    .mockResolvedValueOnce("second-url");
  window.mangaApi = createTestMangaGatewayStub({ getPageImageDataUrl: load });
  const view = render(
    <>
      <PageStatus page={page} statusMode="translation" locked />
      <PageListThumbnail page={page} observeThumbnail={visible} />
    </>,
  );
  expect(screen.getByText(/편집 잠김/)).not.toBeNull();
  await waitFor(() =>
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      "first-url",
    ),
  );
  fireEvent.error(view.container.querySelector("img") as HTMLImageElement);
  await waitFor(() =>
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      "second-url",
    ),
  );
  fireEvent.error(view.container.querySelector("img") as HTMLImageElement);
  await waitFor(() =>
    expect(view.container.querySelector('[data-state="error"]')).not.toBeNull(),
  );
  expect(load).toHaveBeenCalledTimes(2);
});

it("ignores a thumbnail request that finishes after page navigation and reports only the current failure", async () => {
  let failFirst: (error: Error) => void = () => {};
  const first = new Promise<string>((_resolve, reject) => {
    failFirst = reject;
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const load = vi
    .fn()
    .mockReturnValueOnce(first)
    .mockRejectedValueOnce(new Error("current image missing"));
  window.mangaApi = createTestMangaGatewayStub({ getPageImageDataUrl: load });
  const page = { ...makePage(), dataUrl: "" };
  const view = render(
    <PageListThumbnail page={page} observeThumbnail={visible} />,
  );
  await waitFor(() => expect(load).toHaveBeenCalledOnce());
  view.rerender(
    <PageListThumbnail
      page={{ ...page, imagePath: "new-page.png" }}
      observeThumbnail={visible}
    />,
  );
  await waitFor(() =>
    expect(view.container.querySelector('[data-state="error"]')).not.toBeNull(),
  );
  await act(async () => {
    failFirst(new Error("old request"));
    await Promise.resolve();
  });
  expect(error).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ message: "current image missing" }),
  );
});

it("keeps the page list mounted when its thumbnail bridge throws synchronously", async () => {
  window.mangaApi = createTestMangaGatewayStub({
    getPageImageDataUrl: () => {
      throw new Error("preload unavailable");
    },
  });
  const view = render(
    <PageListThumbnail
      page={{ ...makePage(), dataUrl: "" }}
      observeThumbnail={visible}
    />,
  );
  await waitFor(() =>
    expect(view.container.querySelector('[data-state="error"]')).not.toBeNull(),
  );
  expect(view.container.firstElementChild).not.toBeNull();
});
