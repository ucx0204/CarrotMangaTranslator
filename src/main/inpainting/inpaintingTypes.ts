import type { MangaPage } from "../../shared/types";

export type PatternPageInpaintingResult = {
  page: MangaPage;
  blocksErased: number;
};

export type ImageDecodeFallback = (filePath: string) => Promise<Buffer | null>;
