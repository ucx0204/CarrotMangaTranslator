/** @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStatusLog } from "../src/renderer/src/hooks/useStatusLog";

describe("status log session history", () => {
  it("keeps every line in memory and starts empty after remounting", () => {
    const first = renderHook(() => useStatusLog());

    act(() => {
      for (let index = 1; index <= 40; index += 1) {
        first.result.current.appendStatusLine(`상태 기록 ${index}`);
      }
    });

    expect(first.result.current.statusLines).toHaveLength(40);
    expect(first.result.current.statusLines[0]).toBe("상태 기록 40");
    expect(first.result.current.statusLines[39]).toBe("상태 기록 1");

    first.unmount();
    const restarted = renderHook(() => useStatusLog());
    expect(restarted.result.current.statusLines).toEqual([]);
  });
});
