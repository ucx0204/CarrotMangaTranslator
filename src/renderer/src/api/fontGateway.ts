import { createMangaDomainGateway } from "./mangaGateway";

export const fontGateway = createMangaDomainGateway("Font", [
  "getFontLibrary",
  "listCustomFonts",
  "onFontLibraryChanged",
  "registerCustomFont",
  "removeCustomFont",
  "saveFontPreferences",
] as const);
