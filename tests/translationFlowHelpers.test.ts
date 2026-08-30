import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import {
  runSelectionsSequentially,
  setFlowTerminal,
} from "../src/renderer/src/hooks/translationFlowHelpers";

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

  it("attributes multi-chapter progress to the chapter being processed", async () => {
    const execute = vi.fn().mockResolvedValue("completed");
    const pushStatus = vi.fn();

    await runSelectionsSequentially(execute, selections, pushStatus, "번역");

    expect(pushStatus.mock.calls).toEqual([
      ["번역 1/3화", "chapter-1"],
      ["번역 2/3화", "chapter-2"],
      ["번역 3/3화", "chapter-3"],
    ]);
  });

  it.each([
    ["balanced", "balanced"],
    ["detailed", undefined],
  ] as const)(
    "forwards the %s cumulative-context policy only when needed",
    async (detail, expected) => {
      const execute = vi.fn().mockResolvedValue("completed");

      await runSelectionsSequentially(
        execute,
        [selections[0]],
        vi.fn(),
        "1차",
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        detail,
      );

      const payload = execute.mock.calls[0]?.[0];
      if (expected) {
        expect(payload).toEqual(
          expect.objectContaining({ cumulativeContextDetail: expected }),
        );
      } else {
        expect(payload).not.toHaveProperty("cumulativeContextDetail");
      }
    },
  );

  it("publishes terminal flow status without an elapsed-time suffix", () => {
    const setJobState = vi.fn();
    const pushStatus = vi.fn();
    const context = {
      setJobState,
      pushStatus,
      t: ((key: string) => key) as TFunction<"renderer">,
    };

    setFlowTerminal(context, "completed", "번역 완료", undefined, 12_345);
    setFlowTerminal(
      context,
      "partial",
      "일부 완료",
      "확인 필요",
      undefined,
      "increase-context-length",
    );
    setFlowTerminal(context, "failed", "실패");

    expect(pushStatus.mock.calls).toEqual([["번역 완료"], ["확인 필요"]]);
    expect(setJobState).toHaveBeenNthCalledWith(
      1,
      expect.not.objectContaining({ jobElapsedMs: expect.anything() }),
    );
    expect(setJobState).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "inpainting",
        phase: "partial",
        detail: "확인 필요",
        failureGuidance: "increase-context-length",
      }),
    );
  });
});
