import { createMangaDomainGateway } from "./mangaGateway";

export const settingsGateway = createMangaDomainGateway("Settings", [
  "discoverApiModels",
  "getAppUpdateInfo",
  "getRuntimeCapabilities",
  "getSettings",
  "getUiLocale",
  "onModelTestEvent",
  "onUiLocaleChanged",
  "openAmdHipSdkDownload",
  "openApiProviderPage",
  "openReleasesPage",
  "pickLocalMmprojFile",
  "pickLocalModelFile",
  "resetSettings",
  "saveSettings",
  "testModelSettings",
] as const);
