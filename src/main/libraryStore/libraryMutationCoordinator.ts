import type { AppActivityResource } from "../../shared/appActivityTypes";
import {
  AppActivityBusyError,
  type AppActivityGate,
  type AppActivityDescriptor,
} from "../appActivityGate";

type LibraryMutationCoordinatorState = "open" | "closing" | "recovery-required";

type LibraryMutationLease = {
  finish: () => void;
};

export type LibraryMutationSuspensionLease = {
  release: () => void;
};

const RECOVERY_REQUIRED_MESSAGE =
  "보관함 transaction 복구가 필요합니다. 앱을 종료하고 다시 실행하세요.";
const CLOSING_MESSAGE = "앱이 종료 중이라 새 보관함 작업을 시작할 수 없습니다.";
const SUSPENDED_MESSAGE =
  "보관함 작업이 일시적으로 중지되어 새 작업을 시작할 수 없습니다.";

class LibraryMutationCoordinator {
  private activityGate: AppActivityGate | null = null;

  configureActivityGate(gate: AppActivityGate | null): void {
    this.activityGate = gate;
  }

  assertActivityAccess(
    resources: readonly AppActivityResource[],
    ownerId?: string,
  ): void {
    const conflict = this.activityGate?.findConflict(resources, ownerId);
    if (conflict) {
      throw new AppActivityBusyError(conflict, resources);
    }
  }

  acquireActivity(descriptor: Omit<AppActivityDescriptor, "startedAt">) {
    return this.activityGate?.acquire(descriptor);
  }

  async acquireActivityWhenAvailable(
    descriptor: Omit<AppActivityDescriptor, "startedAt">,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    return this.activityGate?.acquireWhenAvailable(descriptor, signal);
  }
  private state: LibraryMutationCoordinatorState = "open";
  private activeCount = 0;
  private idleWaiters = new Set<() => void>();
  private recoveryError: unknown = null;
  private readonly suspensionTokens = new Set<symbol>();

  begin(): LibraryMutationLease {
    return this.admit(false);
  }

  /** Only reference-aware artifact cleanup may drain after intake closes. */
  beginArtifactCleanup(): LibraryMutationLease {
    return this.admit(true);
  }

  private admit(artifactCleanup: boolean): LibraryMutationLease {
    if (this.state === "closing" && !artifactCleanup) {
      throw new Error(CLOSING_MESSAGE);
    }
    if (this.state === "recovery-required") {
      throw this.createRecoveryRequiredError();
    }
    if (this.suspensionTokens.size > 0) {
      throw new Error(SUSPENDED_MESSAGE);
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

  suspendNewMutations(): LibraryMutationSuspensionLease {
    const token = Symbol("library-mutation-suspension");
    this.suspensionTokens.add(token);

    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.suspensionTokens.delete(token);
      },
    };
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
    if (this.state !== "recovery-required") {
      this.recoveryError = error;
    }
    this.state = "recovery-required";
  }

  clearRecoveryRequiredAfterStartup(): void {
    this.recoveryError = null;
    this.state = "open";
  }

  /**
   * Re-checks a callback admitted before it waited on a lock.
   *
   * `closing` is intentionally allowed here: mutations admitted before
   * `before-quit` remain tracked and must finish or roll back.
   * `recovery-required` is never allowed because the library may already be
   * inconsistent after a failed rollback.
   */
  assertExecutionAllowed(): void {
    if (this.state === "recovery-required") {
      throw this.createRecoveryRequiredError();
    }
  }

  assertReadable(): void {
    this.assertExecutionAllowed();
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
