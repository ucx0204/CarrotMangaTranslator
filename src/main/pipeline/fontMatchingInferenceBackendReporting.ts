import {
  resolveFontMatchingExecutionBackend,
  type FontMatchingExecutionBackend,
} from "./fontMatchingPagePixelInference";

type BackendReporter = (message: string, detail: unknown) => void;

export function reportFontMatchingInferenceBackend({
  activeBackend,
  reportInfo,
  reportWarning,
}: {
  activeBackend: FontMatchingExecutionBackend;
  reportInfo?: BackendReporter;
  reportWarning?: BackendReporter;
}): void {
  const requestedBackend = resolveFontMatchingExecutionBackend();
  const detail = { requestedBackend, activeBackend };
  if (activeBackend === requestedBackend) {
    reportInfo?.("Font matching inference backend ready", detail);
    return;
  }
  reportWarning?.(
    "Font matching GPU backend was unavailable; using WASM fallback.",
    detail,
  );
}
