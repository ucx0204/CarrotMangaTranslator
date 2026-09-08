import type { Worker } from "node:worker_threads";
import type {
  FontMatchingWorkerInitMessage,
  FontMatchingWorkerOutboundMessage,
} from "./fontMatchingInferenceWorker";
import type { FontMatchingRuntimeArtifactStatus } from "./fontMatchingRuntimeArtifactStatus";
import { reportFontMatchingInferenceBackend } from "./fontMatchingInferenceBackendReporting";

type InitializationOptions = {
  target: Worker;
  message: Omit<FontMatchingWorkerInitMessage, "wasmAssets">;
  resolveWasmAssets: () => Promise<FontMatchingWorkerInitMessage["wasmAssets"]>;
  isCurrent: () => boolean;
  reportInfo?: (message: string, detail: unknown) => void;
  reportWarning?: (message: string, detail: unknown) => void;
};

export function initializeFontMatchingWorker(options: InitializationOptions): {
  readiness: Promise<FontMatchingRuntimeArtifactStatus>;
  cancel: (error: unknown) => void;
} {
  const { target, message: initMessage } = options;
  let cancel!: (error: unknown) => void;
  const readiness = new Promise<FontMatchingRuntimeArtifactStatus>(
    (resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        settled = true;
        target.off("message", onMessage);
        target.off("error", onError);
        target.off("exit", onExit);
      };
      const onMessage = (message: FontMatchingWorkerOutboundMessage): void => {
        if (settled) return;
        if (message.type === "ready" && message.id === initMessage.id) {
          cleanup();
          if (message.backend) {
            reportFontMatchingInferenceBackend({
              activeBackend: message.backend,
              reportInfo: options.reportInfo,
              reportWarning: options.reportWarning,
            });
          }
          resolve(message.status);
        } else if (
          message.type === "init-error" &&
          message.id === initMessage.id
        ) {
          cleanup();
          reject(
            Object.assign(new Error(message.error.message), {
              name: message.error.name,
            }),
          );
        }
      };
      const onError = (error: unknown): void => {
        if (settled) return;
        cleanup();
        reject(error);
      };
      const onExit = (code: number): void => {
        onError(
          new Error(
            `Font matching worker exited before initialization completed: ${code}`,
          ),
        );
      };
      cancel = onError;
      target.on("message", onMessage);
      target.on("error", onError);
      target.on("exit", onExit);
      void Promise.resolve()
        .then(options.resolveWasmAssets)
        .then((wasmAssets) => {
          if (settled) return;
          if (!options.isCurrent()) {
            onError(new Error("Font matching worker terminated."));
            return;
          }
          target.postMessage({ ...initMessage, wasmAssets });
        })
        .catch(onError);
    },
  );
  return { readiness, cancel };
}
