import { expect, it } from "vitest";
import type { JobEvent } from "../src/shared/jobTypes";
import { updateRedactionReviewQueue } from "../src/renderer/src/components/imageRedaction/redactionReviewQueue";

function review(id: string): JobEvent {
  return {
    id,
    kind: "gemma-analysis",
    status: "running",
    imageRedactionReview: { sessionId: id, pages: [] },
  };
}
it("retains the visible editor as a draft after its job is cancelled", () => {
  const state = updateRedactionReviewQueue([], review("a"));
  const next = updateRedactionReviewQueue(state, {
    id: "a",
    kind: "gemma-analysis",
    status: "cancelled",
  });
  expect(next).toHaveLength(1);
  expect(next[0].sessionId).toBe("a");
  expect(next[0].jobActive).toBe(false);
  expect(next[0].pages).toBe(state[0].pages);
});
it("queues a later job instead of replacing a draft and drops never-edited cancelled reviews", () => {
  const a = updateRedactionReviewQueue([], review("a"));
  const both = updateRedactionReviewQueue(a, review("b"));
  expect(both.map((item) => item.jobId)).toEqual(["a", "b"]);
  expect(both[0]).toBe(a[0]);
  const next = updateRedactionReviewQueue(both, {
    id: "b",
    kind: "gemma-analysis",
    status: "failed",
  });
  expect(next).toEqual(a);
});
it("does not reset draft state on repeated reviews or unrelated progress", () => {
  const a = updateRedactionReviewQueue([], review("a"));
  expect(updateRedactionReviewQueue(a, review("a"))).toBe(a);
  expect(
    updateRedactionReviewQueue(a, {
      id: "b",
      kind: "gemma-analysis",
      status: "completed",
    }),
  ).toBe(a);
});
