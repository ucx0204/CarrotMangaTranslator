import React from "react";
import { Translation } from "react-i18next";
import { errorReportGateway } from "../lib/errorReportGateway";
import { Button } from "./ui/Button";
import { ErrorReportDialog } from "./ErrorReportDialog";
import { Modal } from "./ui/Modal";

type ErrorBoundaryProps = {
  children: React.ReactNode;
  onRecover?: () => void;
};

type ErrorBoundaryState = {
  error: Error | null;
  componentStack: string;
  reportOpen: boolean;
};

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    error: null,
    componentStack: "",
    reportOpen: false,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, componentStack: "", reportOpen: false };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({
      componentStack: info.componentStack ?? "",
      reportOpen: !this.props.onRecover,
    });
    void errorReportGateway
      .writeLog("error", "렌더러 화면 오류", {
        error,
        message: error.message,
        stack: error.stack ?? "",
        componentStack: info.componentStack ?? "",
      })
      .catch((logError) => {
        console.error(logError);
      });
  }

  private readonly handleRestart = async (): Promise<void> => {
    try {
      await errorReportGateway.restartApp();
    } catch (error) {
      console.error(error);
      window.location.reload();
    }
  };

  private readonly handleOpenLogs = (): void => {
    void errorReportGateway.openLogFolder().catch((error) => {
      console.error(error);
    });
  };

  private readonly handleOpenReport = (): void => {
    this.setState({ reportOpen: true });
  };

  private readonly handleCloseReport = (): void => {
    this.setState({ reportOpen: false });
  };

  private readonly handleRecover = (): void => {
    this.props.onRecover?.();
    this.setState({ error: null, reportOpen: false, componentStack: "" });
  };

  render(): React.ReactNode {
    const { componentStack, error, reportOpen } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <Translation ns="components">
        {(t) =>
          this.props.onRecover ? (
            <Modal
              title={t("errorBoundary.title")}
              onClose={this.handleRecover}
              footer={
                <Button onClick={this.handleRecover}>
                  {t("errorBoundary.closePanel")}
                </Button>
              }
            >
              <p role="alert">{t("errorBoundary.panelDescription")}</p>
              <Button onClick={this.handleOpenReport}>
                {t("errorBoundary.report")}
              </Button>
              {reportOpen ? (
                <ErrorReportDialog
                  context={{
                    source: "react-boundary",
                    summary: error.message,
                    message: error.message,
                    stack: error.stack,
                    componentStack,
                  }}
                  onClose={this.handleCloseReport}
                />
              ) : null}
            </Modal>
          ) : (
            <div className="app-crash" role="alert">
              <div className="app-crash-card">
                <h1>{t("errorBoundary.title")}</h1>
                <p>{t("errorBoundary.description")}</p>
                {error.message ? (
                  <pre className="app-crash-detail">{error.message}</pre>
                ) : null}
                <div className="app-crash-actions">
                  <Button variant="primary" onClick={this.handleRestart}>
                    {t("errorBoundary.restart")}
                  </Button>
                  <Button onClick={this.handleOpenReport}>
                    {t("errorBoundary.report")}
                  </Button>
                  <Button onClick={this.handleOpenLogs}>
                    {t("errorBoundary.openLogs")}
                  </Button>
                </div>
              </div>
              {reportOpen ? (
                <ErrorReportDialog
                  context={{
                    source: "react-boundary",
                    summary: error.message || t("errorBoundary.title"),
                    message: error.message,
                    stack: error.stack,
                    componentStack,
                  }}
                  fatal
                  onClose={this.handleCloseReport}
                  onRestart={this.handleRestart}
                />
              ) : null}
            </div>
          )
        }
      </Translation>
    );
  }
}
