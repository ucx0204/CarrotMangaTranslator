import type { MangaPage } from "../../shared/libraryTypes";

export type PatternPageInpaintingResult = {
  page: MangaPage;
  blocksErased: number;
  blocksIncomplete?: number;
  erasedBlockIds?: string[];
  incompleteBlockIds?: string[];
};

export type ImageDecodeFallback = (filePath: string) => Promise<Buffer | null>;
