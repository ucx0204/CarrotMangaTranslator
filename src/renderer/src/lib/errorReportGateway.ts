import type { MangaApi } from "../../../shared/mangaApi";
import { mangaGateway } from "../api/mangaGateway";

type ErrorReportGateway = Pick<
  MangaApi,
  | "copyErrorReport"
  | "onErrorIncident"
  | "openErrorReportIssue"
  | "openLogFolder"
  | "prepareErrorReport"
  | "restartApp"
  | "writeLog"
>;

export const errorReportGateway: ErrorReportGateway = {
  copyErrorReport: (body) => mangaGateway.copyErrorReport(body),
  onErrorIncident: (callback) => mangaGateway.onErrorIncident(callback),
  openErrorReportIssue: (request) => mangaGateway.openErrorReportIssue(request),
  openLogFolder: () => mangaGateway.openLogFolder(),
  prepareErrorReport: (context) => mangaGateway.prepareErrorReport(context),
  restartApp: () => mangaGateway.restartApp(),
  writeLog: (level, message, detail) =>
    mangaGateway.writeLog(level, message, detail),
};
