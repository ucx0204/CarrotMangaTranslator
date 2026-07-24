import { createMangaDomainGateway } from "./mangaGateway";

export const exportGateway = createMangaDomainGateway("Export", [
  "exportPageImages",
] as const);
