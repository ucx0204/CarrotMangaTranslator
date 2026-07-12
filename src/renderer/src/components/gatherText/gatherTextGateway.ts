import type { MangaApi } from "../../../../shared/mangaApi";
import { mangaGateway } from "../../api/mangaGateway";

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
