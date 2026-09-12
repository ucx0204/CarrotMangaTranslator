import React from "react";
import { useSoundEffectTextReview } from "../hooks/useSoundEffectTextReview";
import { SoundEffectTextReviewModal } from "./SoundEffectTextReviewModal";

export function SoundEffectTextReviewDialog() {
  const state = useSoundEffectTextReview();
  return state.pending ? (
    <SoundEffectTextReviewModal
      key={state.pending.review.sessionId}
      review={state.pending.review}
      busy={state.busy}
      error={state.error}
      onConfirm={state.confirm}
      onClose={state.cancel}
    />
  ) : null;
}
