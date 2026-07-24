import { createMangaDomainGateway } from "./mangaGateway";

export const appGateway = createMangaDomainGateway("App", [
  "copyErrorReport",
  "getLogPath",
  "onErrorIncident",
  "openErrorReportIssue",
  "openLibraryFolder",
  "openLogFolder",
  "prepareErrorReport",
  "restartApp",
  "writeLog",
] as const);
