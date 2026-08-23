import { createMangaDomainGateway } from "./mangaGateway";

export const blockLibraryGateway = createMangaDomainGateway("BlockLibrary", [
  "deleteBlockLibraryEntry",
  "listBlockLibraryEntries",
  "renameBlockLibraryEntry",
  "saveBlockLibraryEntry",
  "updateBlockLibraryEntry",
  "useBlockLibraryEntry",
] as const);
