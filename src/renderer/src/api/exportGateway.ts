import { createMangaDomainGateway } from "./mangaGateway";

export const exportGateway = createMangaDomainGateway("Export", [
  "exportPageImages",
  "preflightPageImages",
] as const);
