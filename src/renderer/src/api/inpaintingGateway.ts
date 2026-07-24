import { createMangaDomainGateway } from "./mangaGateway";

export const inpaintingGateway = createMangaDomainGateway("Inpainting", [
  "applyInpaintingHistoryTransaction",
  "applyInpaintingRetouch",
  "disposeInpaintingEngine",
  "releaseInpaintingHistoryTransactions",
  "revertInpainting",
  "sampleInpaintingColor",
  "setPageInpaintingResult",
  "startInpainting",
] as const);
