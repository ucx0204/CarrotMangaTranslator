import { createMangaDomainGateway } from "./mangaGateway";

export const exportGateway = createMangaDomainGateway("Export", [
  "exportPageImages",
  "exportPagePsd",
  "preflightPageImages",
] as const);
