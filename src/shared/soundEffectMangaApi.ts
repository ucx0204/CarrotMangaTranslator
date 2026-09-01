import type {
  PrepareSoundEffectTranslationRequest,
  PrepareSoundEffectTranslationResult,
  StartSoundEffectTranslationRequest,
  StartSoundEffectTranslationResult,
} from "./analysisTypes";
import type { ChapterSnapshot } from "./libraryTypes";

export type SoundEffectMangaApi = {
  dismissSoundEffectReviewRegion: (
    chapterId: string,
    pageId: string,
    regionId: string,
  ) => Promise<ChapterSnapshot>;
  prepareSoundEffectTranslation: (
    request: PrepareSoundEffectTranslationRequest,
  ) => Promise<PrepareSoundEffectTranslationResult>;
  startSoundEffectTranslation: (
    request: StartSoundEffectTranslationRequest,
  ) => Promise<StartSoundEffectTranslationResult>;
};
