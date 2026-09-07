import type { FontStyleSelectionV2 } from "../../shared/fontMatchingProfileTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import type { TranslationOptions } from "../appSettings";
import type { OverlayItem } from "./types";

export type FontChapterC18Style = FontStyleSelectionV2 & {
  runtimeVersion: "c23.0";
  groupId: string;
};

export type FontChapterC18Resolver = (
  pageId: string,
  item: OverlayItem,
) => FontChapterC18Style | undefined;

export type FontChapterC18Page = Readonly<{
  page: MangaPage;
  items: readonly OverlayItem[];
  pageOptions: TranslationOptions;
}>;

export type FontChapterC18Port = {
  prepare: (
    pages: readonly FontChapterC18Page[],
    signal: AbortSignal,
  ) => Promise<FontChapterC18Resolver | undefined>;
};
