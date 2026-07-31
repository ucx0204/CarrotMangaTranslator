import { describe, expect, it, vi } from "vitest";
import { runSelectionsSequentially } from "../src/renderer/src/hooks/translationFlowHelpers";

const selections = [
  { chapterId: "chapter-1", mode: "all" as const },
  { chapterId: "chapter-2", mode: "all" as const },
  { chapterId: "chapter-3", mode: "all" as const },
];

describe("sequential chapter translation flow", () => {
  it("stops immediately after a chapter failure", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce("completed")
      .mockResolvedValueOnce("failed")
      .mockResolvedValueOnce("completed");

    await expect(
      runSelectionsSequentially(execute, selections, vi.fn(), "1차"),
    ).resolves.toBe("failed");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("completes only when every attempted chapter completes", async () => {
    const execute = vi.fn().mockResolvedValue("completed");

    await expect(
      runSelectionsSequentially(execute, selections, vi.fn(), "1차"),
    ).resolves.toBe("completed");
  });
});
