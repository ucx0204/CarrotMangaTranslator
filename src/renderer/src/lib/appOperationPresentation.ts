import type { TFunction } from "i18next";
import type {
  AppOperationActivityEvent,
  AppOperationPhase,
} from "../../../shared/appOperationTypes";
import { formatBytes } from "./jobProgressFormatting";

type AppOperationActivityPresentation = Pick<
  AppOperationActivityEvent,
  "kind" | "status" | "phase" | "sourceKind"
>;

export function formatAppOperationActivity(
  activity: AppOperationActivityPresentation,
  t: TFunction<"renderer">,
): string {
  const kind = resolveAppOperationKindLabel(activity, t);
  const state =
    activity.status === "running" && activity.phase
      ? resolveAppOperationPhaseLabel(activity.phase, t)
      : t(`statusDock.operation.status.${activity.status}`);
  return t("statusDock.operation.summary", { kind, state });
}

function resolveAppOperationKindLabel(
  activity: AppOperationActivityPresentation,
  t: TFunction<"renderer">,
): string {
  // Earlier releases recorded completed ZIP inspections under the restore kind.
  if (
    activity.kind === "environment-restore" &&
    activity.status === "completed" &&
    activity.phase === "share-reading"
  )
    return t("statusDock.operation.kind.environmentPreview");
  if (activity.kind === "library-import-preview") {
    return t("statusDock.operation.kind.importPreview", {
      source: activity.sourceKind
        ? t(`statusDock.operation.source.${activity.sourceKind}`)
        : t("statusDock.operation.source.files"),
    });
  }
  if (activity.kind === "web-import-preview") {
    return activity.phase === "web-preparing"
      ? t("statusDock.operation.kind.webPrepare")
      : t("statusDock.operation.kind.webScan");
  }
  const labels = {
    "environment-backup": "statusDock.operation.kind.environmentBackup",
    "environment-backup-preview":
      "statusDock.operation.kind.environmentPreview",
    "environment-restore": "statusDock.operation.kind.environmentRestore",
    "library-import": "statusDock.operation.kind.libraryImport",
    "work-share-import": "statusDock.operation.kind.shareImport",
    "work-share-export": "statusDock.operation.kind.shareExport",
    "model-test": "statusDock.operation.kind.modelTest",
    "claude-auth": "statusDock.operation.kind.claudeAuth",
    "codex-auth": "statusDock.operation.kind.codexAuth",
    "grok-auth": "statusDock.operation.kind.grokAuth",
  } as const;
  return t(labels[activity.kind] ?? "statusDock.operation.kind.background");
}

function resolveAppOperationPhaseLabel(
  phase: AppOperationPhase,
  t: TFunction<"renderer">,
): string {
  return t(`statusDock.operation.phase.${phase}`);
}

export function isAppOperationActive(
  activity: AppOperationActivityEvent | null,
): boolean {
  return activity?.status === "running" || activity?.status === "cancelling";
}

export type AppOperationProgress = { current: number; total: number };

export function resolveAppOperationProgress(
  activity: Pick<
    AppOperationActivityEvent,
    "progressCurrent" | "progressTotal"
  >,
): AppOperationProgress | null {
  const current = activity.progressCurrent;
  const total = activity.progressTotal;
  if (
    typeof current !== "number" ||
    !Number.isFinite(current) ||
    typeof total !== "number" ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }
  return {
    current: Math.min(total, Math.max(0, current)),
    total,
  };
}

export function formatAppOperationProgress(
  activity: Pick<AppOperationActivityEvent, "progressUnit">,
  progress: AppOperationProgress,
  locale: string,
  formatPercent: (value: number) => string,
): string {
  const { current, total } = progress;
  if (activity.progressUnit === "bytes") {
    return `${formatBytes(current, locale) ?? current} / ${
      formatBytes(total, locale) ?? total
    }`;
  }
  if (activity.progressUnit === "percent") {
    return formatPercent(Math.round((current / Math.max(1, total)) * 100));
  }
  return `${Math.floor(current)} / ${Math.floor(total)}`;
}
