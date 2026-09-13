import { z } from "zod";
import { defineIpcContract } from "./ipcContractCore";
import {
  confirmSoundEffectTextReviewSchema,
  type ConfirmSoundEffectTextReview,
} from "./soundEffectTextReview";
import {
  confirmRegionTranslationSchema,
  type ConfirmRegionTranslationRequest,
} from "./regionTextReview";

export const translationReviewIpcContracts = {
  confirmSoundEffectTextReview: defineIpcContract<
    [ConfirmSoundEffectTextReview],
    boolean
  >({
    apiKey: "confirmSoundEffectTextReview",
    channel: "job:confirm-sound-effect-text-review",
    args: z.tuple([confirmSoundEffectTextReviewSchema]),
    result: z.boolean(),
  }),
  confirmRegionTranslation: defineIpcContract<
    [ConfirmRegionTranslationRequest],
    boolean
  >({
    apiKey: "confirmRegionTranslation",
    channel: "job:confirm-region-translation",
    args: z.tuple([confirmRegionTranslationSchema]),
    result: z.boolean(),
  }),
} as const;
