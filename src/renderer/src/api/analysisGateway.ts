import { createMangaDomainGateway } from "./mangaGateway";

export const analysisGateway = createMangaDomainGateway("Analysis", [
  "cancelJob",
  "cancelWorkContextResearch",
  "onJobEvent",
  "researchWorkContext",
  "startAnalysis",
  "translateRegion",
] as const);
