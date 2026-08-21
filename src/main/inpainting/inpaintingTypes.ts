import type { MangaPage } from "../../shared/libraryTypes";
import type { PatternSourceGlyphResidualDiagnostic } from "./sourceGlyphResidual";
import type { PatternSourceGlyphEvidenceReceipt } from "./sourceGlyphEvidenceReceipt";

export type PatternPageInpaintingResult = {
  page: MangaPage;
  blocksErased: number;
  blocksIncomplete?: number;
  erasedBlockIds?: string[];
  incompleteBlockIds?: string[];
  residualDiagnostics?: PatternSourceGlyphResidualDiagnostic[];
  sourceEvidenceReceipt?: PatternSourceGlyphEvidenceReceipt;
};

export type ImageDecodeFallback = (filePath: string) => Promise<Buffer | null>;
