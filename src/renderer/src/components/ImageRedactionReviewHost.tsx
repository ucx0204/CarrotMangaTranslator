import React from "react";
import type { ImageRedactionReview } from "../../../shared/imageRedaction";
import { analysisGateway } from "../api/analysisGateway";
import { ImageRedactionModal } from "./ImageRedactionModal";

export function ImageRedactionReviewHost(): React.JSX.Element | null {
  const [review, setReview] = React.useState<
    (ImageRedactionReview & { jobId: string }) | null
  >(null);
  React.useEffect(
    () =>
      analysisGateway.onJobEvent((event) => {
        if (event.imageRedactionReview)
          setReview({ ...event.imageRedactionReview, jobId: event.id });
        if (
          ["cancelled", "failed", "completed", "partial"].includes(event.status)
        )
          setReview((current) =>
            current?.jobId === event.id ? null : current,
          );
      }),
    [],
  );
  return review ? (
    <ImageRedactionModal
      key={review.sessionId}
      review={review}
      onClose={() => setReview(null)}
    />
  ) : null;
}
