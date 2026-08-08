type LibraryMutationCoordinatorState = "open" | "closing" | "recovery-required";

type LibraryMutationLease = {
  finish: () => void;
};

const RECOVERY_REQUIRED_MESSAGE =
  "보관함 transaction 복구가 필요합니다. 앱을 종료하고 다시 실행하세요.";
const CLOSING_MESSAGE = "앱이 종료 중이라 새 보관함 작업을 시작할 수 없습니다.";

class LibraryMutationCoordinator {
  private state: LibraryMutationCoordinatorState = "open";
  private activeCount = 0;
  private idleWaiters = new Set<() => void>();
  private recoveryError: unknown = null;

  begin(): LibraryMutationLease {
    if (this.state === "closing") {
      throw new Error(CLOSING_MESSAGE);
    }
    if (this.state === "recovery-required") {
      throw this.createRecoveryRequiredError();
    }
    this.activeCount += 1;
    let finished = false;
    return {
      finish: () => {
        if (finished) {
          return;
        }
        finished = true;
        this.activeCount -= 1;
        if (this.activeCount === 0) {
          for (const resolve of this.idleWaiters) {
            resolve();
          }
          this.idleWaiters.clear();
        }
      },
    };
  }

  closeToNewMutations(): void {
    if (this.state === "open") {
      this.state = "closing";
    }
  }

  waitForIdle(): Promise<void> {
    if (this.activeCount === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  markRecoveryRequired(error: unknown): void {
    this.recoveryError = error;
    this.state = "recovery-required";
  }

  clearRecoveryRequiredAfterStartup(): void {
    this.recoveryError = null;
    this.state = "open";
  }

  assertReadable(): void {
    if (this.state === "recovery-required") {
      throw this.createRecoveryRequiredError();
    }
  }

  getStateForTests(): LibraryMutationCoordinatorState {
    return this.state;
  }

  getActiveCountForTests(): number {
    return this.activeCount;
  }

  private createRecoveryRequiredError(): Error {
    return new Error(RECOVERY_REQUIRED_MESSAGE, {
      ...(this.recoveryError === null ? {} : { cause: this.recoveryError }),
    });
  }
}

export const libraryMutationCoordinator = new LibraryMutationCoordinator();

export function assertLibraryReadable(): void {
  libraryMutationCoordinator.assertReadable();
}
