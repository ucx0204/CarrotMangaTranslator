import React from "react";
import { errorReportGateway } from "../lib/errorReportGateway";
import {
  closeErrorReport,
  useErrorReportIncident,
} from "../lib/errorReportStore";
import { ErrorReportDialog } from "./ErrorReportDialog";

export function ErrorReportHost({
  fatal = false,
  closeWindowOnDismiss = false,
}: {
  fatal?: boolean;
  closeWindowOnDismiss?: boolean;
}): React.JSX.Element | null {
  const context = useErrorReportIncident();
  if (!context) {
    return null;
  }

  const handleClose = (): void => {
    closeErrorReport();
    if (closeWindowOnDismiss) {
      window.close();
    }
  };

  return (
    <ErrorReportDialog
      context={context}
      fatal={fatal}
      onClose={handleClose}
      onRestart={() => errorReportGateway.restartApp()}
    />
  );
}
