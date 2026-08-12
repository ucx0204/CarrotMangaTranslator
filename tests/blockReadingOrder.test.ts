import { describe, expect, it } from "vitest";
import {
  inferPageBlockOrder,
  resolvePageBlockOrder,
  resolveReadingDirection,
} from "../src/shared/blockReadingOrder";

describe("persisted block reading order", () => {
  const blocks = [
    { id: "left", bbox: { x: 100, y: 100, w: 100, h: 100 } },
    { id: "right", bbox: { x: 700, y: 110, w: 100, h: 100 } },
    { id: "lower", bbox: { x: 500, y: 500, w: 100, h: 100 } },
  ];

  it("infers geometry using the selected direction", () => {
    expect(inferPageBlockOrder(blocks, "rtl")).toEqual([
      "right",
      "left",
      "lower",
    ]);
    expect(inferPageBlockOrder(blocks, "ltr")).toEqual([
      "left",
      "right",
      "lower",
    ]);
  });

  it("repairs duplicate and stale stored ids, then appends new blocks", () => {
    expect(
      resolvePageBlockOrder(
        { blocks, blockOrder: ["lower", "missing", "lower", "right"] },
        "rtl",
      ),
    ).toEqual(["lower", "right", "left"]);
  });

  it("uses explicit work direction and otherwise falls back to inference", () => {
    expect(resolveReadingDirection("ltr", "rtl")).toBe("ltr");
    expect(resolveReadingDirection("auto", "rtl")).toBe("rtl");
    expect(resolveReadingDirection(undefined, "ltr")).toBe("ltr");
  });
});
