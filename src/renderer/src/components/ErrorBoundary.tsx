import React from "react";
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
      <div className="app-crash" role="alert">
        <div className="app-crash-card">
          <h1>문제가 발생했어요</h1>
          <p>
            화면을 그리는 중 오류가 발생했습니다. 작업 내용은 보관함에 저장돼
            있을 수 있어요. 다시 시작하면 대부분 복구됩니다.
          </p>
          {error.message ? (
            <pre className="app-crash-detail">{error.message}</pre>
          ) : null}
          <div className="app-crash-actions">
            <Button variant="primary" onClick={this.handleReload}>
              다시 시작
            </Button>
            <Button onClick={this.handleOpenLogs}>로그 폴더 열기</Button>
          </div>
        </div>
      </div>
    );
  }
}
