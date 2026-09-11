import { expect, it } from "vitest";
import { redactionMaskWindow } from "../src/renderer/src/components/imageRedaction/redactionMaskWindow";

it("bounds native inspection to the viewport rather than the full long image", () => {
  const visible = { x: 500, y: 8000, width: 900, height: 700 };
  const result = redactionMaskWindow(
    { width: 3000, height: 10000 },
    visible,
    100,
  );
  expect(result.factor).toBe(1);
  expect(result.width * result.height).toBeLessThan(1100000);
  expect(result.x).toBeLessThanOrEqual(visible.x);
  expect(result.y).toBeLessThanOrEqual(visible.y);
  expect(result.x + result.width).toBeGreaterThanOrEqual(
    visible.x + visible.width,
  );
  expect(result.y + result.height).toBeGreaterThanOrEqual(
    visible.y + visible.height,
  );
});
it("reduces an overview with aligned power-of-two pixels while retaining native pixels at 100%", () => {
  const page = { width: 3000, height: 10000 };
  const result = redactionMaskWindow(page, { x: 0, y: 0, ...page }, 7);
  expect(result.factor).toBe(8);
  expect(
    Math.ceil(result.width / result.factor) *
      Math.ceil(result.height / result.factor),
  ).toBeLessThan(500000);
  const corner = redactionMaskWindow(
    page,
    { x: 2990, y: 9990, width: 10, height: 10 },
    800,
  );
  expect(corner.x + corner.width).toBe(page.width);
  expect(corner.y + corner.height).toBe(page.height);
  expect(corner.factor).toBe(1);
});
