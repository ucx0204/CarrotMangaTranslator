import type { MangaPage } from "../../shared/libraryTypes";

export type PatternPageInpaintingResult = {
  page: MangaPage;
  blocksErased: number;
};

export type ImageDecodeFallback = (filePath: string) => Promise<Buffer | null>;
