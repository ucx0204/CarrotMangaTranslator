import type { MangaApi } from "../../../../shared/mangaApi";
import { libraryGateway as mangaGateway } from "../../api/libraryGateway";

type RequestOf<TMethod extends keyof MangaApi> = Parameters<
  MangaApi[TMethod]
>[0];

export const gatherTextGateway = {
  saveTextFile: (request: RequestOf<"saveTextFile">) =>
    mangaGateway.saveTextFile(request),
  exportReviewText: (request: RequestOf<"exportReviewText">) =>
    mangaGateway.exportReviewText(request),
  importReviewText: (request: RequestOf<"importReviewText">) =>
    mangaGateway.importReviewText(request),
};
