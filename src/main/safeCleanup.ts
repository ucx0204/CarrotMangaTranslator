import { logWarn } from "./logger";

export async function safeCleanup(
  label: string,
  cleanup: () => Promise<void> | void,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    logWarn("Cleanup failed", { label, error });
  }
}
