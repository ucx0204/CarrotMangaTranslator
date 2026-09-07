import type { ChildProcess } from "node:child_process";

/** Retained until stream closure: late shutdown errors must also have an owner. */
export function observeProcessErrors(
  child: ChildProcess,
  onError: (error: Error) => void,
  onPipeError = onError,
): void {
  child.on("error", onError);
  for (const pipe of [child.stdin, child.stdout, child.stderr])
    pipe?.on("error", onPipeError);
}
