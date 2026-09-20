/** @vitest-environment jsdom */
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePageListWindow } from "../src/renderer/src/components/pageList/usePageListWindow";
import { usePageListState } from "../src/renderer/src/components/pageList/usePageListState";
import { PageList } from "../src/renderer/src/components/PageList";
import type { MangaPage } from "../src/shared/libraryTypes";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("bounds mounted page rows in a long chapter and reveals a distant selection", () => {
  const pages: MangaPage[] = Array.from({ length: 500 }, (_, i) => ({
    id: `page-${i}`,
    name: `${i}.png`,
    dataUrl: "",
    imagePath: `${i}.png`,
    width: 100,
    height: 150,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-09-20",
    updatedAt: "2026-09-20",
  }));
  const props = {
    pages,
    collapsed: false,
    otherPanelCollapsed: false,
    jobActive: false,
    onSelect: vi.fn(),
    onRetranslate: vi.fn(),
    onRemove: vi.fn(),
    onReorder: vi.fn(),
    onToggleOtherPanel: vi.fn(),
  };
  const started = performance.now();
  const view = render(<PageList {...props} selectedPageId={null} />);
  const rows = view.container.querySelectorAll(".page-item").length;
  process.stdout.write(
    `page-list benchmark: 500 pages, ${rows} mounted rows, ${(performance.now() - started).toFixed(1)}ms mount\n`,
  );
  expect(rows).toBeLessThan(40);
  const first = view.getByTitle("0.png");
  act(() => first.focus());
  const viewport = view.getByRole("list");
  viewport.scrollTop = 84 * 200;
  fireEvent.scroll(viewport);
  expect(document.activeElement).toBe(first);
  expect(view.container.querySelector('[title="1.png"]')).not.toBeNull();
  expect(view.container.querySelectorAll(".page-item").length).toBeLessThan(40);
  view.rerender(<PageList {...props} selectedPageId="page-450" />);
  expect(
    view.container
      .querySelector('[aria-current="page"]')
      ?.getAttribute("title"),
  ).toBe("450.png");
  const reordered = [...pages];
  reordered.splice(1, 0, reordered.splice(450, 1)[0]);
  view.rerender(
    <PageList {...props} pages={reordered} selectedPageId="page-450" />,
  );
  expect(
    view.container
      .querySelector('[data-page-id="page-450"]')
      ?.getAttribute("aria-posinset"),
  ).toBe("2");
  view.rerender(
    <PageList {...props} pages={pages.slice(0, 4)} selectedPageId="page-2" />,
  );
  expect(view.container.querySelectorAll(".page-item")).toHaveLength(4);
});

it("keeps filtered ordering and mounts drop targets only for the active drag", () => {
  const pages = Array.from(
    { length: 120 },
    (_, i): MangaPage => ({
      id: String(i),
      name: String(i),
      imagePath: "",
      dataUrl: "",
      width: 1,
      height: 1,
      blocks: [],
      analysisStatus: i % 2 ? "failed" : "completed",
      createdAt: "",
      updatedAt: "",
    }),
  );
  const viewport = document.createElement("div");
  const ref = { current: viewport };
  const onReorder = vi.fn();
  const view = renderHook(
    ({ dragging, locked }) => {
      const state = usePageListState({
        pages,
        jobActive: locked,
        selectedPageId: "119",
        statusMode: "translation",
        onReorder,
      });
      return {
        state,
        window: usePageListWindow(ref, state.visiblePages, "119", dragging),
      };
    },
    { initialProps: { dragging: false, locked: false } },
  );
  expect(view.result.current.window.rows.length).toBeLessThan(40);
  view.rerender({ dragging: true, locked: false });
  expect(view.result.current.window.rows).toHaveLength(120);
  view.rerender({ dragging: false, locked: false });
  act(() => view.result.current.state.setFilter("failed"));
  expect(view.result.current.state.visiblePages).toHaveLength(60);
  expect(view.result.current.state.selectedPageHidden).toBe(false);
  expect(view.result.current.window.rows.map(({ page }) => page.id)).toEqual(
    pages
      .filter((page) => page.analysisStatus === "failed")
      .map((page) => page.id),
  );
  act(() => view.result.current.state.setFilter("completed"));
  expect(view.result.current.state.selectedPageHidden).toBe(true);
  expect(onReorder).not.toHaveBeenCalled();
});

it.each([30, 500])(
  "does not rerender a %i-page viewport for every scroll pixel",
  (count) => {
    const element = document.createElement("div");
    const viewportRef = { current: element };
    const pages = Array.from(
      { length: count },
      (_, index) => ({ id: String(index) }) as MangaPage,
    );
    let renders = 0;
    const view = renderHook(() => {
      renders++;
      return usePageListWindow(viewportRef, pages, null, false);
    });
    const initial = renders;
    for (let top = 1; top <= 180; top++) {
      element.scrollTop = top;
      act(() => view.result.current.onScroll());
    }
    expect(renders - initial).toBeLessThan(count > 100 ? 10 : 1);
    if (count > 100)
      expect(view.result.current.rows.map((row) => row.index)).toContain(9);
    else expect(view.result.current.rows).toHaveLength(count);
  },
);
it("keeps a manually scrolled viewport when page content changes, but reveals a moved selection", () => {
  const element = document.createElement("div");
  const ref = { current: element };
  const pages = Array.from(
    { length: 500 },
    (_, index) => ({ id: String(index) }) as MangaPage,
  );
  const view = renderHook(
    ({ items }) => usePageListWindow(ref, items, "0", false),
    { initialProps: { items: pages } },
  );
  element.scrollTop = 84 * 200;
  act(() => view.result.current.onScroll());
  view.rerender({
    items: pages.map((page) => ({ ...page, updatedAt: "changed" })),
  });
  expect(element.scrollTop).toBe(84 * 200);
  expect(view.result.current.rows.some((row) => row.index === 200)).toBe(true);
  view.rerender({ items: [...pages.slice(1), pages[0]] });
  expect(element.scrollTop).toBe(84 * 500 - 600);
  expect(view.result.current.rows.some((row) => row.page.id === "0")).toBe(
    true,
  );
});
