/** @vitest-environment jsdom */

import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import type { JobEvent, JobState } from "../src/shared/jobTypes";
import {
  fallbackJobLabelFromStatus,
  formatElapsedDuration,
  isEditableTarget,
  isInteractiveControlTarget,
  regionSelectionToBbox,
  reorderByTarget,
  reorderRecordsByIdOrder,
  resolveInstallLogLines,
  resolveStatusLineReplacement,
  statusLineReplacementGroup,
} from "../src/renderer/src/lib/appHelpers";

const translated = ((key: string) =>
  `translated:${key}`) as TFunction<"renderer">;

describe("renderer app helpers", () => {
  it("normalizes selection geometry and stable ID ordering", () => {
    expect(
      regionSelectionToBbox({
        active: true,
        dragging: false,
        start: { x: 20.6, y: 30.2 },
        current: { x: 5.2, y: 10.7 },
      }),
    ).toEqual({ x: 5, y: 11, w: 15, h: 20 });

    const order = ["a", "b", "c"];
    expect(reorderByTarget(order, "a", "c")).toEqual(["b", "c", "a"]);
    expect(reorderByTarget(order, "missing", "c")).toBe(order);
    expect(
      reorderRecordsByIdOrder(
        [{ id: "a" }, { id: "b" }, { id: "c" }],
        ["c", "missing", "a"],
      ),
    ).toEqual([{ id: "c" }, { id: "a" }, { id: "b" }]);
  });

  it("recognizes editable DOM targets without treating arbitrary nodes as input", () => {
    const input = document.createElement("input");
    const plain = document.createElement("div");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");

    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(document.createTextNode("text"))).toBe(false);
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(plain)).toBe(false);
    expect(isEditableTarget(editable)).toBe(true);
  });

  it("distinguishes interactive controls from a focusable workspace surface", () => {
    const workspace = document.createElement("div");
    workspace.tabIndex = 0;
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    const customRadio = document.createElement("div");
    customRadio.setAttribute("role", "radio");
    workspace.append(tab, customRadio);

    expect(isInteractiveControlTarget(null)).toBe(false);
    expect(isInteractiveControlTarget(workspace)).toBe(false);
    expect(isInteractiveControlTarget(tab)).toBe(true);
    expect(isInteractiveControlTarget(customRadio)).toBe(true);
  });

  it("formats every localized elapsed-duration scale", () => {
    expect(formatElapsedDuration(500, translated)).toBe(
      "translated:job.elapsed.lessThanSecond",
    );
    expect(formatElapsedDuration(2_000, translated)).toBe(
      "translated:job.elapsed.seconds",
    );
    expect(formatElapsedDuration(61_000, translated)).toBe(
      "translated:job.elapsed.minutesSeconds",
    );
    expect(formatElapsedDuration(3_661_000, translated)).toBe(
      "translated:job.elapsed.hoursMinutesSeconds",
    );
  });

  it("covers every fallback status and install-log merge path", () => {
    for (const status of [
      "starting",
      "running",
      "cancelling",
      "cancelled",
      "failed",
      "partial",
      "completed",
      "idle",
    ] as const) {
      expect(fallbackJobLabelFromStatus(status, translated)).toContain(
        "translated:job.status.",
      );
    }

    const current = {
      status: "running",
      installLogLines: ["old"],
    } as JobState;
    const withLog = { installLogLine: "new" } as JobEvent;
    const withoutLog = {} as JobEvent;
    expect(resolveInstallLogLines(current, withLog, true)).toEqual([
      "old",
      "new",
    ]);
    expect(resolveInstallLogLines(current, withLog, false)).toEqual(["new"]);
    expect(resolveInstallLogLines(current, withoutLog, true)).toEqual(["old"]);
    expect(resolveInstallLogLines(current, withoutLog, false)).toBeUndefined();
  });

  it("groups replaceable progress lines and preserves an explicit predecessor", () => {
    const ocrEvent = {
      phase: "ocr_running",
      pageIndex: 1,
      pageTotal: 2,
    } as JobEvent;
    expect(statusLineReplacementGroup(ocrEvent)).toBe("ocr-progress");
    expect(
      statusLineReplacementGroup({ phase: "ocr_preparing" } as JobEvent),
    ).toBe("ocr-progress");
    expect(
      statusLineReplacementGroup({ phase: "page_retry" } as JobEvent),
    ).toBe("translation-progress");
    expect(statusLineReplacementGroup({ phase: "page_done" } as JobEvent)).toBe(
      "typography-progress",
    );
    expect(
      statusLineReplacementGroup({ phase: "page_skipped" } as JobEvent),
    ).toBe("translation-progress");
    expect(
      statusLineReplacementGroup({
        kind: "inpainting",
        phase: "inpainting_running",
      } as JobEvent),
    ).toBe("inpainting-progress");
    expect(
      statusLineReplacementGroup({
        kind: "page-export",
        phase: "finalizing",
      } as JobEvent),
    ).toBe("page-export-progress");
    expect(
      statusLineReplacementGroup({ phase: "model_downloading" } as JobEvent),
    ).toBe("model-preparing");
    expect(
      statusLineReplacementGroup({ phase: "done" } as JobEvent),
    ).toBeNull();

    const matcher = resolveStatusLineReplacement(ocrEvent, "직전 상태");
    expect(matcher?.("직전 상태")).toBe(true);
    expect(matcher?.("1 / 2 페이지 Paddle OCR 분석 중")).toBe(true);
    expect(matcher?.("Paddle OCR 배치 위치 분석 중")).toBe(true);
    expect(matcher?.("Paddle OCR 선분석 완료")).toBe(true);
    expect(matcher?.("무관한 상태")).toBe(false);
    const typographyMatcher = resolveStatusLineReplacement({
      phase: "page_done",
    } as JobEvent);
    expect(typographyMatcher?.("4 / 50 페이지 완료")).toBe(true);
    expect(typographyMatcher?.("4 / 50 페이지 글자·폰트 맞춤 중")).toBe(true);
    const inpaintingMatcher = resolveStatusLineReplacement({
      kind: "inpainting",
      phase: "inpainting_done",
    } as JobEvent);
    expect(inpaintingMatcher?.("12 / 38 페이지 원문 지우는 중")).toBe(true);
    expect(inpaintingMatcher?.("12 / 38 페이지 원문 완료")).toBe(true);
    expect(inpaintingMatcher?.("11 / 38 페이지 그린 영역 완료")).toBe(true);
    expect(inpaintingMatcher?.("12 / 38 페이지 번역 완료")).toBe(false);
    const exportMatcher = resolveStatusLineReplacement({
      kind: "page-export",
      phase: "finalizing",
    } as JobEvent);
    expect(exportMatcher?.("12 / 38 페이지 출력 중")).toBe(true);
    expect(exportMatcher?.("12 / 38 페이지 출력 완료")).toBe(true);
    expect(exportMatcher?.("12 / 38 페이지 번역 완료")).toBe(false);
    expect(
      resolveStatusLineReplacement({ phase: "done" } as JobEvent),
    ).toBeUndefined();
  });
});
