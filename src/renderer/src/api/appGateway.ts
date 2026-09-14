import { createMangaDomainGateway } from "./mangaGateway";

export const appGateway = createMangaDomainGateway("App", [
  "getAppActivities",
  "getActiveJobs",
  "onAppActivities",
  "finishPageEditHandoff",
  "retryPageEditHandoff",
  "getActiveAppOperations",
  "cancelAppOperation",
  "copyErrorReport",
  "getActiveAppOperation",
  "getLogPath",
  "onErrorIncident",
  "onAppOperationActivity",
  "openErrorReportIssue",
  "openLibraryFolder",
  "openLogFolder",
  "openResearchSource",
  "prepareErrorReport",
  "restartApp",
  "writeLog",
] as const);
