import { createMangaDomainGateway } from "./mangaGateway";

export const analysisGateway = createMangaDomainGateway("Analysis", [
  "analyzeWorkContext",
  "cancelJob",
  "onJobEvent",
  "startAnalysis",
  "translateRegion",
] as const);
