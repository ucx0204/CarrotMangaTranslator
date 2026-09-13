import React from "react";
import { analysisGateway } from "../api/analysisGateway";
import { ImageRedactionModal } from "./ImageRedactionModal";
import {
  updateRedactionReviewQueue,
  type HostedRedactionReview,
} from "./imageRedaction/redactionReviewQueue";

export function ImageRedactionReviewHost(): React.JSX.Element | null {
  const [reviews, setReviews] = React.useState<HostedRedactionReview[]>([]);
  React.useEffect(
    () =>
      analysisGateway.onJobEvent((event) => {
        setReviews((current) => updateRedactionReviewQueue(current, event));
      }),
    [],
  );
  const review = reviews[0];
  return review ? (
    <ImageRedactionModal
      key={review.sessionId}
      review={review}
      jobActive={review.jobActive}
      onClose={() =>
        setReviews((current) =>
          current.filter((item) => item.sessionId !== review.sessionId),
        )
      }
    />
  ) : null;
}
