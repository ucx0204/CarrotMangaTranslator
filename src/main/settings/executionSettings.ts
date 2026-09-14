import { AsyncLocalStorage } from "node:async_hooks";
import type { AppSettings } from "../../shared/settingsTypes";

const executionSettings = new AsyncLocalStorage<AppSettings | undefined>();

export function withExecutionSettings<T>(
  settings: AppSettings | undefined,
  run: () => T,
): T {
  return executionSettings.run(
    settings ? structuredClone(settings) : undefined,
    run,
  );
}

export function readExecutionSettings(): AppSettings | undefined {
  const settings = executionSettings.getStore();
  return settings ? structuredClone(settings) : undefined;
}
