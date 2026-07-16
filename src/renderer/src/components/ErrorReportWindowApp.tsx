import React from "react";
import { useTranslation } from "react-i18next";
import { ErrorReportHost } from "./ErrorReportHost";
import { useErrorReportIncident } from "../lib/errorReportStore";
import "../styles.css";

export function ErrorReportWindowApp(): React.JSX.Element {
  const { t } = useTranslation("components");
  const incident = useErrorReportIncident();
  return (
    <>
      <main className="app-crash">
        <div className="app-crash-card" role="status">
          <h1>{t("errorReport.fatalTitle")}</h1>
          <p>{t("errorReport.preparing")}</p>
        </div>
      </main>
      {incident ? <ErrorReportHost fatal closeWindowOnDismiss /> : null}
    </>
  );
}
