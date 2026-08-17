import { createMangaDomainGateway } from "./mangaGateway";

export const settingsGateway = createMangaDomainGateway("Settings", [
  "discoverApiModels",
  "getAppUpdateInfo",
  "getRuntimeCapabilities",
  "getSettings",
  "getDefaultSettings",
  "getUiLocale",
  "onModelTestEvent",
  "onUiLocaleChanged",
  "openAmdHipSdkDownload",
  "openApiProviderPage",
  "openVertexSetupPage",
  "openReleasesPage",
  "pickLocalMmprojFile",
  "pickLocalModelFile",
  "pickVertexServiceAccountFile",
  "resetSettings",
  "saveSettings",
  "testModelSettings",
] as const);
