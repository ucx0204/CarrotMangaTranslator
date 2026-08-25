import { describe, expect, it } from "vitest";
import { JobEventSchema } from "../src/shared/ipcSchemas";

describe("job elapsed IPC fields", () => {
  it("accepts non-negative page and job elapsed times", () => {
    const event = {
      id: "job-1",
      kind: "gemma-analysis" as const,
      status: "completed" as const,
      progressText: "completed",
      phase: "done" as const,
      pageElapsedMs: 12_345,
      jobElapsedMs: 67_890,
    };

    expect(JobEventSchema.safeParse(event).success).toBe(true);
    expect(
      JobEventSchema.safeParse({ ...event, jobElapsedMs: -1 }).success,
    ).toBe(false);
    expect(
      JobEventSchema.safeParse({
        ...event,
        failureGuidance: "increase-max-output-tokens",
      }).success,
    ).toBe(true);
    expect(
      JobEventSchema.safeParse({
        ...event,
        failureGuidance: "unknown-limit",
      }).success,
    ).toBe(false);
  });
});
