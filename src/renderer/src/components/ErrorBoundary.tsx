import React from "react";
import { Translation } from "react-i18next";
import { mangaGateway } from "../api/mangaGateway";
import { Button } from "./ui";

type ErrorBoundaryProps = {
  children: React.ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    void mangaGateway
      .writeLog("error", "렌더러 화면 오류", {
        message: error.message,
        stack: error.stack ?? "",
        componentStack: info.componentStack ?? "",
      })
      .catch((logError) => {
        console.error(logError);
      });
  }

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  private readonly handleOpenLogs = (): void => {
    void mangaGateway.openLogFolder().catch((error) => {
      console.error(error);
    });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <Translation ns="components">
        {(t) => (
          <div className="app-crash" role="alert">
            <div className="app-crash-card">
              <h1>{t("errorBoundary.title")}</h1>
              <p>{t("errorBoundary.description")}</p>
              {error.message ? (
                <pre className="app-crash-detail">{error.message}</pre>
              ) : null}
              <div className="app-crash-actions">
                <Button variant="primary" onClick={this.handleReload}>
                  {t("errorBoundary.restart")}
                </Button>
                <Button onClick={this.handleOpenLogs}>
                  {t("errorBoundary.openLogs")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Translation>
    );
  }
}
