export type WarningCollector = {
  readonly warnings: string[];
  add: (...items: string[]) => void;
  addAttemptFailure: (input: {
    pageName: string;
    attempt: number;
    maxAttempts: number;
    message: string;
  }) => void;
  addPageSkipped: (input: {
    pageName: string;
    maxAttempts: number;
    message: string;
  }) => void;
};

export function createWarningCollector(): WarningCollector {
  const warnings: string[] = [];
  return {
    warnings,
    add: (...items) => warnings.push(...items),
    addAttemptFailure({ pageName, attempt, maxAttempts, message }) {
      warnings.push(
        `${pageName}: 시도 ${attempt}/${maxAttempts} 실패 - ${message}`,
      );
    },
    addPageSkipped({ pageName, maxAttempts, message }) {
      warnings.push(
        `${pageName}: ${maxAttempts}회 재시도 후 실패하여 이 페이지는 건너뜁니다. 마지막 오류: ${message}`,
      );
    },
  };
}
