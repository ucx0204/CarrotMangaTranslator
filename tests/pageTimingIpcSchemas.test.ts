import { describe, expect, it } from "vitest";
import {
  StartAnalysisRequestSchema,
  StartInpaintingRequestSchema,
  parseIpcPayload,
} from "../src/shared/ipcSchemas";
import { FinishPageTimingSessionRequestSchema } from "../src/shared/ipcPageTimingSchemas";

const chapterId = "22222222-2222-4222-8222-222222222222";
const workId = "11111111-1111-4111-8111-111111111111";
const timingSession = {
  id: "00000000-0000-4000-8000-000000000010",
  startedAtEpochMs: 1_788_047_525_000,
};

describe("page timing IPC schemas", () => {
  it("accepts the same session in translation and automatic inpainting", () => {
    const analysis = parseIpcPayload(
      StartAnalysisRequestSchema,
      { chapterId, runMode: "all", timingSession },
      "번역 작업",
    );
    const inpainting = parseIpcPayload(
      StartInpaintingRequestSchema,
      {
        mode: "selection-pattern",
        workId,
        selections: [{ chapterId, mode: "all" }],
        timingSession,
      },
      "인페인팅",
    );

    expect(analysis.timingSession).toEqual(timingSession);
    expect(inpainting.timingSession).toEqual(timingSession);
  });

  it("accepts only terminal states and non-negative elapsed time", () => {
    expect(
      parseIpcPayload(
        FinishPageTimingSessionRequestSchema,
        {
          chapterId,
          sessionId: timingSession.id,
          elapsedMs: 1_060_000,
          state: "completed",
        },
        "소요 시간 정산",
      ).elapsedMs,
    ).toBe(1_060_000);
    expect(() =>
      parseIpcPayload(
        FinishPageTimingSessionRequestSchema,
        {
          chapterId,
          sessionId: timingSession.id,
          elapsedMs: -1,
          state: "running",
        },
        "소요 시간 정산",
      ),
    ).toThrow(/요청 형식/);
  });
});
