import { createMangaDomainGateway } from "./mangaGateway";

export const analysisGateway = createMangaDomainGateway("Analysis", [
  "cancelJob",
  "cancelWorkContextResearch",
  "finishPageTimingSession",
  "onJobEvent",
  "onPageTimingUpdated",
  "researchWorkContext",
  "startAnalysis",
  "translateRegion",
] as const);
