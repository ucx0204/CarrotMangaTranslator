import { app } from "electron";
import { homedir, release as osRelease } from "node:os";
import { join } from "node:path";
import type {
  ErrorReportContext,
  ErrorReportDraft,
} from "../shared/errorReportTypes";
import { ERROR_REPORT_LOG_MAX_BYTES } from "../shared/errorReportTypes";
import type { AppSettings } from "../shared/settingsTypes";
import type { AppPaths } from "./appPaths";
import { detectBestGpuInfo, type DetectedGpuInfo } from "./gpuInfo";
import { getAppSettings } from "./settingsStore";
import { redactDiagnosticText } from "./errorReportRedaction";
import {
  readRecentDiagnosticLogEntries,
  type DiagnosticLogEntry,
} from "./errorReportLogs";

export { redactDiagnosticText } from "./errorReportRedaction";

const ERROR_SECTION_MAX_BYTES = 10 * 1024;
const SYSTEM_SECTION_MAX_BYTES = 4 * 1024;
const ERROR_REPORT_DRAFT_MAX_BYTES = 54 * 1024;
const TRUNCATION_MARKER = "\n\n_… diagnostic content truncated …_\n";

export type ErrorReportBuildEnvironment = {
  appPaths: AppPaths;
  appVersion: string;
  locale: string;
  isPackaged: boolean;
  platform: string;
  arch: string;
  osRelease: string;
  electronVersion: string;
  nodeVersion: string;
  settings: AppSettings | null;
  gpu: DetectedGpuInfo | null;
  currentLogPath: string;
  previousLogPath: string;
  homeDir?: string;
};

export async function prepareErrorReportDraft(
  context: ErrorReportContext,
  appPaths: AppPaths,
): Promise<ErrorReportDraft> {
  const [settingsResult, gpuResult] = await Promise.allSettled([
    getAppSettings(appPaths),
    detectBestGpuInfo(),
  ]);
  return buildErrorReportDraft(context, {
    appPaths,
    appVersion: app.getVersion(),
    locale: app.getLocale(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    osRelease: osRelease(),
    electronVersion: process.versions.electron ?? "unknown",
    nodeVersion: process.versions.node,
    settings:
      settingsResult.status === "fulfilled" ? settingsResult.value : null,
    gpu: gpuResult.status === "fulfilled" ? gpuResult.value : null,
    currentLogPath: appPaths.logFile,
    previousLogPath: join(appPaths.logsDir, "previous.log"),
    homeDir: homedir(),
  });
}

export async function buildErrorReportDraft(
  context: ErrorReportContext,
  environment: ErrorReportBuildEnvironment,
): Promise<ErrorReportDraft> {
  const redactionOptions = {
    appPaths: environment.appPaths,
    homeDir: environment.homeDir,
  };
  let redactionCount = 0;
  let truncated = false;

  const errorRedaction = redactDiagnosticText(
    buildErrorMarkdown(context),
    redactionOptions,
  );
  redactionCount += errorRedaction.redactionCount;
  const boundedError = truncateUtf8(
    errorRedaction.text,
    ERROR_SECTION_MAX_BYTES,
  );
  truncated ||= boundedError.truncated;

  const systemRedaction = redactDiagnosticText(
    buildSystemMarkdown(environment),
    redactionOptions,
  );
  redactionCount += systemRedaction.redactionCount;
  const boundedSystem = truncateUtf8(
    systemRedaction.text,
    SYSTEM_SECTION_MAX_BYTES,
  );
  truncated ||= boundedSystem.truncated;

  const logEntries = await readRecentDiagnosticLogEntries(
    environment.previousLogPath,
    environment.currentLogPath,
  );
  const redactedLogEntries = logEntries.map((entry) => {
    const result = redactDiagnosticText(entry.line, redactionOptions);
    redactionCount += result.redactionCount;
    return { ...entry, line: result.text };
  });
  const bytesRemaining =
    ERROR_REPORT_DRAFT_MAX_BYTES -
    utf8ByteLength(boundedError.text) -
    utf8ByteLength(boundedSystem.text);
  const renderedLogs = renderLogMarkdown(
    redactedLogEntries,
    Math.min(ERROR_REPORT_LOG_MAX_BYTES, Math.max(bytesRemaining, 0)),
  );
  truncated ||= renderedLogs.truncated;

  return {
    defaultTitle: defaultTitleForSource(context.source),
    errorMarkdown: boundedError.text,
    systemMarkdown: boundedSystem.text,
    logsMarkdown: renderedLogs.text,
    redactionCount,
    truncated,
  };
}

function buildErrorMarkdown(context: ErrorReportContext): string {
  const lines = ["## Error", "", `- Source: \`${context.source}\``];
  appendOptionalListItem(lines, "Summary", context.summary);
  appendOptionalListItem(lines, "Job stage", context.jobStage, true);
  appendOptionalCodeSection(lines, "Message", context.message);
  appendOptionalCodeSection(lines, "Stack", context.stack);
  appendOptionalCodeSection(
    lines,
    "React component stack",
    context.componentStack,
  );
  const hasDetails = [
    context.summary,
    context.message,
    context.stack,
    context.componentStack,
  ].some(hasText);
  if (!hasDetails) {
    lines.push("", "_No exception details were supplied._");
  }
  return lines.join("\n");
}

function buildSystemMarkdown(environment: ErrorReportBuildEnvironment): string {
  const settings = environment.settings;
  const lines = [
    "## System information",
    "",
    `- App version: \`${environment.appVersion}\``,
    `- Build: \`${environment.isPackaged ? "packaged" : "development"}\``,
    `- Electron: \`${environment.electronVersion}\``,
    `- Node.js: \`${environment.nodeVersion}\``,
    `- OS: \`${environment.platform} ${environment.osRelease} (${environment.arch})\``,
    `- Locale: \`${environment.locale}\``,
  ];

  if (!settings) {
    lines.push("- App settings: unavailable");
    return lines.join("\n");
  }

  lines.push(...buildSettingsSystemLines(settings, environment.gpu));
  return lines.join("\n");
}

function buildSettingsSystemLines(
  settings: AppSettings,
  gpu: DetectedGpuInfo | null,
): string[] {
  const lines = [
    `- Model provider: \`${settings.modelProvider}\``,
    `- Model: \`${safeModelIdentifier(settings)}\``,
  ];
  if (settings.translation) {
    lines.push(
      `- Translation: \`${settings.translation.sourceLanguage} -> ${settings.translation.targetLanguage}\``,
    );
  }
  const ocrBackend = settings.ocr.gpuBackend
    ? ` / ${settings.ocr.gpuBackend}`
    : "";
  lines.push(
    `- OCR: \`${settings.ocr.device} / ${settings.ocr.qualityMode}${ocrBackend}\``,
  );
  if (settings.inpainting) {
    lines.push(`- Inpainting: \`${inpaintingDescription(settings)}\``);
  }
  lines.push(`- GPU: \`${gpuDescription(settings, gpu)}\``);
  return lines;
}

function inpaintingDescription(settings: AppSettings): string {
  return (
    [
      settings.inpainting?.model,
      settings.inpainting?.fluxBackend,
      settings.inpainting?.koharuBackend,
    ]
      .filter(Boolean)
      .join(" / ") || "default"
  );
}

function gpuDescription(
  settings: AppSettings,
  gpu: DetectedGpuInfo | null,
): string {
  const runtimeGpu = settings.runtimeHardware;
  return (
    [
      firstDefined(gpu?.vendor, runtimeGpu?.gpuVendor),
      firstDefined(gpu?.name, runtimeGpu?.gpuName),
      gpuMemoryDescription(gpu),
      firstDefined(gpu?.rocmTarget, runtimeGpu?.llamaRocmTarget),
    ]
      .filter(Boolean)
      .join(" / ") || "unknown"
  );
}

function firstDefined<T>(...values: Array<T | null | undefined>): T | null {
  return (
    values.find((value): value is T => value !== null && value !== undefined) ??
    null
  );
}

function gpuMemoryDescription(gpu: DetectedGpuInfo | null): string | null {
  return gpu?.memoryMb ? `${gpu.memoryMb} MiB` : null;
}

function renderLogMarkdown(
  entries: DiagnosticLogEntry[],
  maxBytes: number,
): { text: string; truncated: boolean } {
  const empty =
    "## Recent warnings and errors\n\n_No WARN/ERROR entries were found in the current or previous app log._";
  if (entries.length === 0 || maxBytes <= 0) {
    const result = truncateUtf8(empty, maxBytes);
    return { text: result.text, truncated: result.truncated };
  }

  const prefix = "## Recent warnings and errors\n\n```text\n";
  const suffix = "\n```";
  const omission = "[older entries omitted]\n";
  const selected: string[] = [];
  let omitted = false;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const rendered = `[${entry.source}] ${entry.line}`;
    const nextLines = [rendered, ...selected];
    const candidate = `${prefix}${index > 0 ? omission : ""}${nextLines.join("\n")}${suffix}`;
    if (utf8ByteLength(candidate) > maxBytes) {
      omitted = true;
      break;
    }
    selected.unshift(rendered);
  }

  if (selected.length === 0) {
    const latest = `[${entries.at(-1)?.source ?? "current"}] ${
      entries.at(-1)?.line ?? ""
    }`;
    const available =
      maxBytes - utf8ByteLength(prefix) - utf8ByteLength(suffix);
    const bounded = truncateUtf8(latest, Math.max(available, 0));
    return {
      text: `${prefix}${bounded.text}${suffix}`,
      truncated: true,
    };
  }

  const text = `${prefix}${omitted ? omission : ""}${selected.join("\n")}${suffix}`;
  return { text, truncated: omitted };
}

function safeModelIdentifier(settings: AppSettings): string {
  if (settings.modelProvider === "openai-codex") {
    return `${settings.codex.model} / ${settings.codex.reasoningEffort}`;
  }
  if (settings.modelProvider === "openai-api") {
    return settings.api.model;
  }
  if (settings.gemma.modelSource === "local") {
    return `local / ${settings.gemma.vramMode}${settings.gemma.llamaRuntimeProfile ? ` / ${settings.gemma.llamaRuntimeProfile}` : ""}`;
  }
  return `${settings.gemma.modelRepo}/${settings.gemma.modelFile} / ${settings.gemma.vramMode}${settings.gemma.llamaRuntimeProfile ? ` / ${settings.gemma.llamaRuntimeProfile}` : ""}`;
}

function defaultTitleForSource(source: ErrorReportContext["source"]): string {
  switch (source) {
    case "manual":
      return "[Bug] Problem report";
    case "job-failure":
      return "[Bug] Translation or processing job failed";
    case "react-boundary":
      return "[Bug] Renderer component crashed";
    case "renderer-global":
      return "[Bug] Unexpected renderer error";
    case "main-process":
      return "[Bug] Main process error";
    case "renderer-process":
      return "[Bug] Renderer process crashed";
  }
}

function fencedText(value: string): string {
  return `\`\`\`text\n${value.replace(/```/g, "` ` `")}\n\`\`\``;
}

function appendOptionalListItem(
  lines: string[],
  label: string,
  value: string | undefined,
  code = false,
): void {
  if (!hasText(value)) {
    return;
  }
  const normalized = singleLine(value);
  lines.push(`- ${label}: ${code ? `\`${normalized}\`` : normalized}`);
}

function appendOptionalCodeSection(
  lines: string[],
  title: string,
  value: string | undefined,
): void {
  if (hasText(value)) {
    lines.push("", `### ${title}`, "", fencedText(value));
  }
}

function hasText(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (utf8ByteLength(value) <= maxBytes) {
    return { text: value, truncated: false };
  }
  if (maxBytes <= 0) {
    return { text: "", truncated: true };
  }
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER);
  if (maxBytes <= markerBytes) {
    return {
      text: Buffer.from(TRUNCATION_MARKER)
        .subarray(0, maxBytes)
        .toString("utf8"),
      truncated: true,
    };
  }
  const contentBytes = Buffer.from(value).subarray(0, maxBytes - markerBytes);
  return {
    text: `${contentBytes.toString("utf8")}${TRUNCATION_MARKER}`,
    truncated: true,
  };
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
