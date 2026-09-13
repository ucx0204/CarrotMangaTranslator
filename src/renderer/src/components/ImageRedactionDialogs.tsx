import React from "react";
import { ImageRedactionReviewHost } from "./ImageRedactionReviewHost";
import { ImageRedactionPreparationHost } from "./ImageRedactionPreparationHost";

export function ImageRedactionDialogs({
  preparation,
}: {
  preparation: React.ComponentProps<
    typeof ImageRedactionPreparationHost
  > | null;
}): React.JSX.Element {
  return (
    <>
      <ImageRedactionReviewHost />
      {preparation ? <ImageRedactionPreparationHost {...preparation} /> : null}
    </>
  );
}
