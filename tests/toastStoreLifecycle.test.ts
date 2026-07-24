import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dismissToast,
  getToasts,
  toast,
} from "../src/renderer/src/lib/toastStore";

beforeEach(() => {
  vi.useFakeTimers();
  clearToasts();
});

afterEach(() => {
  clearToasts();
  vi.useRealTimers();
});

describe("toast store lifecycle", () => {
  it("keeps removal timers bounded to the visible toast limit", () => {
    for (let index = 0; index < 20; index += 1) {
      toast.info(`notification ${index}`, { duration: 60_000 });
    }

    expect(getToasts()).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(4);
  });
});

function clearToasts(): void {
  for (const item of getToasts()) {
    dismissToast(item.id);
  }
}
