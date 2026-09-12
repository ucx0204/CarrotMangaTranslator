import React from "react";
import { RegionTranslationModal } from "./RegionTranslationModal";
import { TranslationOptionsModal } from "./TranslationOptionsModal";
import { SoundEffectTextReviewDialog } from "./SoundEffectTextReviewDialog";
export function TranslationDialogs({
  region,
  whole,
}: {
  region?: React.ComponentProps<typeof RegionTranslationModal> | null;
  whole: React.ComponentProps<typeof TranslationOptionsModal> | null;
}) {
  return (
    <>
      <SoundEffectTextReviewDialog />
      {region ? <RegionTranslationModal {...region} /> : null}
      {whole ? <TranslationOptionsModal {...whole} /> : null}
    </>
  );
}
