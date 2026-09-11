import type { ImageRedactionReview } from "../../../../shared/imageRedaction";
import type { JobEvent } from "../../../../shared/jobTypes";

export type HostedRedactionReview = ImageRedactionReview & {
  jobId: string;
  jobActive: boolean;
};

/** A terminal job cannot discard the visible editor, or replace it with a new job. */
export function updateRedactionReviewQueue(
  current: HostedRedactionReview[],
  event: JobEvent,
): HostedRedactionReview[] {
  let next = current;
  const review = event.imageRedactionReview;
  if (review && !next.some((item) => item.sessionId === review.sessionId))
    next = [...next, { ...review, jobId: event.id, jobActive: true }];
  if (!["cancelled", "failed", "completed", "partial"].includes(event.status))
    return next;
  if (!next.some((item) => item.jobId === event.id && item.jobActive))
    return next;
  // Queued reviews have never been displayed or edited and need no recovery UI.
  return next.flatMap((item, index) =>
    item.jobId !== event.id
      ? [item]
      : index === 0
        ? [{ ...item, jobActive: false }]
        : [],
  );
}
