import { describe, expect, it } from "vitest";
import {
  resolveAdjacentPageId,
  resolveWheelPageNavigation,
} from "../src/renderer/src/lib/pageNavigation";

describe("page navigation helpers", () => {
  const pageIds = ["page-1", "page-2", "page-3"];

  it("moves to the previous and next page around the current selection", () => {
    expect(resolveAdjacentPageId(pageIds, "page-2", "previous")).toBe("page-1");
    expect(resolveAdjacentPageId(pageIds, "page-2", "next")).toBe("page-3");
  });

  it("does not wrap beyond the first or last page", () => {
    expect(resolveAdjacentPageId(pageIds, "page-1", "previous")).toBeNull();
    expect(resolveAdjacentPageId(pageIds, "page-3", "next")).toBeNull();
  });

  it("treats the first page as current when no explicit selection exists", () => {
    expect(resolveAdjacentPageId(pageIds, null, "previous")).toBeNull();
    expect(resolveAdjacentPageId(pageIds, null, "next")).toBe("page-2");
  });

  it("ignores navigation requests when no pages are available", () => {
    expect(resolveAdjacentPageId([], "page-1", "previous")).toBeNull();
  });

  it("maps vertical mouse wheel movement to previous and next pages", () => {
    expect(
      resolveWheelPageNavigation({
        deltaX: 0,
        deltaY: -80,
        hasPages: true,
        modalOpen: false,
        editableTarget: false,
      }),
    ).toBe("previous");

    expect(
      resolveWheelPageNavigation({
        deltaX: 0,
        deltaY: 80,
        hasPages: true,
        modalOpen: false,
        editableTarget: false,
      }),
    ).toBe("next");
  });

  it("lets a scrollable workspace consume wheel movement before page navigation", () => {
    const base = {
      deltaX: 0,
      hasPages: true,
      modalOpen: false,
      editableTarget: false,
      verticalScroll: {
        scrollTop: 100,
        scrollHeight: 1000,
        clientHeight: 400,
      },
    };

    expect(resolveWheelPageNavigation({ ...base, deltaY: 80 })).toBeNull();
    expect(resolveWheelPageNavigation({ ...base, deltaY: -80 })).toBeNull();
  });

  it("moves pages only after wheel movement reaches the scroll boundary", () => {
    const base = {
      deltaX: 0,
      hasPages: true,
      modalOpen: false,
      editableTarget: false,
      verticalScroll: {
        scrollTop: 0,
        scrollHeight: 1000,
        clientHeight: 400,
      },
    };

    expect(resolveWheelPageNavigation({ ...base, deltaY: -80 })).toBe(
      "previous",
    );
    expect(resolveWheelPageNavigation({ ...base, deltaY: 80 })).toBeNull();
    expect(
      resolveWheelPageNavigation({
        ...base,
        deltaY: 80,
        verticalScroll: {
          scrollTop: 600,
          scrollHeight: 1000,
          clientHeight: 400,
        },
      }),
    ).toBe("next");
  });

  it("ignores tiny, horizontal, modal, editable, and empty wheel navigation", () => {
    const base = {
      hasPages: true,
      modalOpen: false,
      editableTarget: false,
    };

    expect(
      resolveWheelPageNavigation({ ...base, deltaX: 0, deltaY: 4 }),
    ).toBeNull();
    expect(
      resolveWheelPageNavigation({ ...base, deltaX: 80, deltaY: 40 }),
    ).toBeNull();
    expect(
      resolveWheelPageNavigation({
        ...base,
        deltaX: 0,
        deltaY: 80,
        modalOpen: true,
      }),
    ).toBeNull();
    expect(
      resolveWheelPageNavigation({
        ...base,
        deltaX: 0,
        deltaY: 80,
        editableTarget: true,
      }),
    ).toBeNull();
    expect(
      resolveWheelPageNavigation({
        ...base,
        deltaX: 0,
        deltaY: 80,
        hasPages: false,
      }),
    ).toBeNull();
  });
});
