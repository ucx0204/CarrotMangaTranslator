import { createMangaDomainGateway } from "./mangaGateway";

export const appGateway = createMangaDomainGateway("App", [
  "copyErrorReport",
  "getLogPath",
  "onErrorIncident",
  "openErrorReportIssue",
  "openLibraryFolder",
  "openLogFolder",
  "openResearchSource",
  "prepareErrorReport",
  "restartApp",
  "writeLog",
] as const);
